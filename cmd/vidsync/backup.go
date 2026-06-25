package main

// Owner-side Dropbox backup. A background loop mirrors each backup-enabled
// project's materials into the owner's Dropbox and registers a manifest with
// the cloud control plane, so the copy is durable AND reachable by teammates
// while the owner's PC is offline.
//
// Design notes:
//   - Runs entirely in Go, owned by App (not the Syncthing supervisor): it
//     must keep working with the WebView closed, and it leans on the existing
//     Dropbox upload helpers + the daemon's local index.
//   - Files are enumerated from the daemon's SQLite index, which already holds
//     each file's BlocksHash — the same content fingerprint teammates and the
//     backend key on. We upload only files whose BlocksHash changed (dedup),
//     and we never transform the bytes, so a teammate that downloads them
//     reconciles against Syncthing's index by hash with no re-pull and no
//     conflict (validated separately).
//   - The manifest cache is persisted (encrypted, alongside the target list)
//     so an app restart doesn't re-upload everything.

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/CrownLedger/vidsync/internal/db"
	"github.com/CrownLedger/vidsync/internal/itererr"
	"github.com/CrownLedger/vidsync/lib/fs"
	"github.com/CrownLedger/vidsync/lib/protocol"
	"github.com/CrownLedger/vidsync/lib/scanner"
	"github.com/CrownLedger/vidsync/lib/syncthing"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	// backupInterval is how often the loop re-scans enabled folders for
	// changes. Uploads are incremental (by BlocksHash), so a frequent tick is
	// cheap when nothing changed.
	backupInterval = 30 * time.Second
	// backupStateFile holds the persisted target list + manifest caches,
	// DPAPI-encrypted like the other secrets (it carries file paths/names).
	backupStateFile = "backup.bin"
)

// backupTarget is one project the owner has enabled backup for. FolderPath is
// the on-disk root used to read files for upload; AppFolderPath is the prefix
// inside the owner's Dropbox app folder ("/<folderID>").
type backupTarget struct {
	FolderID      string `json:"folderId"`
	FolderPath    string `json:"folderPath"`
	AppFolderPath string `json:"appFolderPath"`
	DeviceID      string `json:"deviceId"`
}

// backupPersisted is the on-disk shape of the manager's durable state.
type backupPersisted struct {
	Targets   map[string]backupTarget      `json:"targets"`
	Manifests map[string]map[string]string `json:"manifests"` // folderID -> path -> contentKey
}

// BackupStatusInfo is the per-project state reported to the frontend.
type BackupStatusInfo struct {
	Enabled          bool   `json:"enabled"`
	Uploading        bool   `json:"uploading"`
	LastBackupUnixMs int64  `json:"lastBackupUnixMs"`
	LastError        string `json:"lastError"`
	FileCount        int    `json:"fileCount"`
}

type backupManager struct {
	a *App

	mu        sync.Mutex
	targets   map[string]backupTarget
	manifests map[string]map[string]string
	status    map[string]*BackupStatusInfo

	trigger chan string // folderID to back up now ("" = all)
	cancel  context.CancelFunc
	done    chan struct{}
}

func newBackupManager(a *App) *backupManager {
	m := &backupManager{
		a:         a,
		targets:   map[string]backupTarget{},
		manifests: map[string]map[string]string{},
		status:    map[string]*BackupStatusInfo{},
		trigger:   make(chan string, 8),
	}
	m.load()
	return m
}

// start launches the background loop. Safe to call once, after the daemon is
// up; the loop tolerates the daemon not being ready yet.
func (m *backupManager) start() {
	if m == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.done = make(chan struct{})
	go m.run(ctx)
}

func (m *backupManager) stop() {
	if m == nil || m.cancel == nil {
		return
	}
	m.cancel()
	<-m.done
}

func (m *backupManager) run(ctx context.Context) {
	defer close(m.done)
	t := time.NewTicker(backupInterval)
	defer t.Stop()
	m.backupAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.backupAll(ctx)
		case fid := <-m.trigger:
			if fid == "" {
				m.backupAll(ctx)
			} else if tgt, ok := m.targetFor(fid); ok {
				m.backupTarget(ctx, tgt)
			}
		}
	}
}

func (m *backupManager) backupAll(ctx context.Context) {
	for _, tgt := range m.allTargets() {
		if ctx.Err() != nil {
			return
		}
		m.backupTarget(ctx, tgt)
	}
}

// kick requests an out-of-band backup of one folder (or all when "").
func (m *backupManager) kick(folderID string) {
	select {
	case m.trigger <- folderID:
	default: // a pass is already queued; the next tick covers it anyway
	}
}

// ---- target / status bookkeeping (all under mu) ----

func (m *backupManager) allTargets() []backupTarget {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]backupTarget, 0, len(m.targets))
	for _, t := range m.targets {
		out = append(out, t)
	}
	return out
}

func (m *backupManager) targetFor(folderID string) (backupTarget, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.targets[folderID]
	return t, ok
}

func (m *backupManager) addTarget(t backupTarget) {
	m.mu.Lock()
	m.targets[t.FolderID] = t
	if m.status[t.FolderID] == nil {
		m.status[t.FolderID] = &BackupStatusInfo{}
	}
	m.status[t.FolderID].Enabled = true
	m.persistLocked()
	m.mu.Unlock()
}

func (m *backupManager) removeTarget(folderID string) {
	m.mu.Lock()
	delete(m.targets, folderID)
	delete(m.manifests, folderID)
	delete(m.status, folderID)
	m.persistLocked()
	m.mu.Unlock()
}

func (m *backupManager) statusFor(folderID string) BackupStatusInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.status[folderID]; ok {
		return *s
	}
	return BackupStatusInfo{}
}

func (m *backupManager) enabledIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.targets))
	for id := range m.targets {
		out = append(out, id)
	}
	return out
}

func (m *backupManager) setStatus(folderID string, mutate func(*BackupStatusInfo)) BackupStatusInfo {
	m.mu.Lock()
	s := m.status[folderID]
	if s == nil {
		s = &BackupStatusInfo{}
		m.status[folderID] = s
	}
	mutate(s)
	snap := *s
	m.mu.Unlock()
	m.a.emitBackup("backup:status", map[string]any{
		"folderId":         folderID,
		"enabled":          snap.Enabled,
		"uploading":        snap.Uploading,
		"lastBackupUnixMs": snap.LastBackupUnixMs,
		"lastError":        snap.LastError,
		"fileCount":        snap.FileCount,
	})
	return snap
}

func (m *backupManager) load() {
	raw, err := loadSecret(backupStateFile)
	if err != nil {
		return // no state yet (or unreadable) — start empty
	}
	var p backupPersisted
	if err := json.Unmarshal(raw, &p); err != nil {
		return
	}
	if p.Targets != nil {
		m.targets = p.Targets
	}
	if p.Manifests != nil {
		m.manifests = p.Manifests
	}
	for id := range m.targets {
		m.status[id] = &BackupStatusInfo{Enabled: true, FileCount: len(m.manifests[id])}
	}
}

// persistLocked writes durable state. Caller must hold mu.
func (m *backupManager) persistLocked() {
	p := backupPersisted{Targets: m.targets, Manifests: m.manifests}
	raw, err := json.Marshal(p)
	if err != nil {
		return
	}
	_ = storeSecret(backupStateFile, raw)
}

// ---- the actual backup of one folder ----

func (m *backupManager) backupTarget(ctx context.Context, tgt backupTarget) {
	folderID := tgt.FolderID
	m.setStatus(folderID, func(s *BackupStatusInfo) { s.Uploading = true; s.LastError = "" })

	finish := func(errMsg string, manifest map[string]string, changed bool) {
		m.setStatus(folderID, func(s *BackupStatusInfo) {
			s.Uploading = false
			s.LastError = errMsg
			if manifest != nil {
				s.FileCount = len(manifest)
			}
			if changed && errMsg == "" {
				s.LastBackupUnixMs = time.Now().UnixMilli()
			}
		})
	}

	sdb := m.a.currentSDB()
	if sdb == nil {
		finish("daemon not ready", nil, false)
		return
	}
	tok, err := validAccessToken()
	if err != nil {
		finish("Dropbox auth: "+err.Error(), nil, false)
		return
	}

	m.mu.Lock()
	old := m.manifests[folderID]
	m.mu.Unlock()
	if old == nil {
		old = map[string]string{}
	}

	newManifest := map[string]string{}
	present := map[string]bool{}
	var deltas []backendMaterial
	var firstErr string

	seq, errFn := sdb.AllLocalFiles(folderID, protocol.LocalDeviceID)
	for fi, err := range itererr.Zip(seq, errFn) {
		if err != nil {
			firstErr = err.Error()
			break
		}
		if ctx.Err() != nil {
			finish("canceled", nil, false)
			return
		}
		name := fi.Name
		if fi.IsDirectory() || fi.IsSymlink() || fi.IsInvalid() || backupSkipName(name) {
			continue
		}
		if fi.IsDeleted() {
			continue // handled by the disappeared-files pass below
		}
		present[name] = true
		ck := hex.EncodeToString(fi.BlocksHash)
		if old[name] == ck {
			newManifest[name] = ck // unchanged — already backed up
			continue
		}
		dbPath := path.Join(tgt.AppFolderPath, name)
		local := filepath.Join(tgt.FolderPath, filepath.FromSlash(name))
		rev, uerr := m.a.dropboxBackupUpload(ctx, tok, local, dbPath, fi.Name, fi.Size)
		if uerr != nil {
			if firstErr == "" {
				firstErr = uerr.Error()
			}
			if prev, ok := old[name]; ok {
				newManifest[name] = prev // keep old; retry next tick
			}
			continue
		}
		newManifest[name] = ck
		deltas = append(deltas, backendMaterial{
			Path:        name,
			ContentKey:  ck,
			SizeBytes:   fi.Size,
			DropboxPath: dbPath,
			DropboxRev:  rev,
		})
	}

	// Files we knew about that are gone now → tombstones.
	for name := range old {
		if !present[name] {
			deltas = append(deltas, backendMaterial{Path: name, Deleted: true})
		}
	}

	if len(deltas) > 0 {
		if err := backendPutMaterials(ctx, folderID, deltas); err != nil {
			finish("manifest sync: "+err.Error(), nil, false)
			return
		}
		m.mu.Lock()
		m.manifests[folderID] = newManifest
		m.persistLocked()
		m.mu.Unlock()
		finish(firstErr, newManifest, true)
		return
	}

	// Nothing changed on the backend; still refresh the in-memory manifest so
	// the live set (and file count) stays accurate.
	m.mu.Lock()
	m.manifests[folderID] = newManifest
	m.mu.Unlock()
	finish(firstErr, newManifest, false)
}

// backupSkipName drops Syncthing's own bookkeeping files from the backup.
func backupSkipName(name string) bool {
	if name == ".stfolder" || name == ".vidsync" {
		return true
	}
	if strings.HasPrefix(name, ".stversions/") || strings.Contains(name, "/.stversions/") {
		return true
	}
	base := path.Base(name)
	if strings.HasPrefix(base, ".syncthing.") && strings.HasSuffix(base, ".tmp") {
		return true
	}
	return false
}

// dropboxBackupUpload uploads one file to Dropbox via an upload session,
// committing with overwrite so a changed file replaces its prior revision.
// Returns the committed file's rev.
func (a *App) dropboxBackupUpload(ctx context.Context, tok, local, dbPath, displayName string, size int64) (string, error) {
	f, err := os.Open(local)
	if err != nil {
		return "", err
	}
	defer f.Close()

	sessionID, err := dropboxSessionStart(tok)
	if err != nil {
		return "", err
	}
	buf := make([]byte, dropboxChunkSize)
	var offset int64
	for {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		n, rerr := io.ReadFull(f, buf)
		if n > 0 {
			if err := dropboxSessionAppend(tok, sessionID, offset, buf[:n]); err != nil {
				return "", err
			}
			offset += int64(n)
			a.emitBackup("backup:progress", map[string]any{
				"name":       displayName,
				"bytesDone":  offset,
				"bytesTotal": size,
			})
		}
		if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
			break
		}
		if rerr != nil {
			return "", rerr
		}
	}
	return dropboxSessionFinishOverwrite(tok, sessionID, offset, dbPath)
}

// dropboxSessionFinishOverwrite commits an upload session at dbPath with
// mode=overwrite (the export path uses add+autorename; backups want a stable
// path that mirrors the source). Returns the committed rev.
func dropboxSessionFinishOverwrite(tok, sessionID string, offset int64, dbPath string) (string, error) {
	arg, _ := json.Marshal(map[string]any{
		"cursor": map[string]any{"session_id": sessionID, "offset": offset},
		"commit": map[string]any{"path": dbPath, "mode": "overwrite", "mute": true},
	})
	resp, err := dropboxContentReq(tok, "https://content.dropboxapi.com/2/files/upload_session/finish", string(arg), nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("upload_session/finish (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var r struct {
		Rev string `json:"rev"`
	}
	_ = json.Unmarshal(body, &r)
	return r.Rev, nil
}

// ---- cloud control-plane client ----

type backendMaterial struct {
	Path        string `json:"path"`
	ContentKey  string `json:"contentKey,omitempty"`
	SizeBytes   int64  `json:"sizeBytes,omitempty"`
	DropboxPath string `json:"dropboxPath,omitempty"`
	DropboxRev  string `json:"dropboxRev,omitempty"`
	Deleted     bool   `json:"deleted,omitempty"`
}

type backendConnectReq struct {
	OwnerDeviceID string `json:"ownerDeviceId"`
	RefreshToken  string `json:"refreshToken"`
	AccountID     string `json:"accountId,omitempty"`
	AppFolderPath string `json:"appFolderPath,omitempty"`
}

var backendHTTP = &http.Client{Timeout: 60 * time.Second}

func cloudAPIBase() string {
	if v := strings.TrimSpace(os.Getenv("VIDSYNC_CLOUD_API_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "https://server.thevidsync.com"
}

func backendDo(ctx context.Context, method, p string, body, out any) error {
	tok, err := loadAuthToken()
	if err != nil || strings.TrimSpace(tok) == "" {
		return errors.New("sign in to thevidsync.com first")
	}
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, cloudAPIBase()+p, r)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := backendHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return fmt.Errorf("backend %s %s (%d): %s", method, p, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out != nil && len(raw) > 0 {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func backendConnectDropbox(ctx context.Context, folderID string, req backendConnectReq) error {
	return backendDo(ctx, http.MethodPost,
		"/v1/projects/"+url.PathEscape(folderID)+"/dropbox/connect", req, nil)
}

func backendPutMaterials(ctx context.Context, folderID string, mats []backendMaterial) error {
	return backendDo(ctx, http.MethodPut,
		"/v1/projects/"+url.PathEscape(folderID)+"/materials",
		map[string]any{"materials": mats}, nil)
}

func backendDisconnectDropbox(ctx context.Context, folderID string) error {
	err := backendDo(ctx, http.MethodDelete,
		"/v1/projects/"+url.PathEscape(folderID)+"/dropbox", nil, nil)
	if err != nil && strings.Contains(err.Error(), "(404)") {
		return nil // already gone
	}
	return err
}

// ---- Wails-bound methods ----

// BackupEnable links a project to the owner's Dropbox and turns on automatic
// backup. folderPath is the project's on-disk root and deviceID is the local
// Syncthing device id (the frontend already has both), matching how the
// invitation flow passes ownerDeviceId.
func (a *App) BackupEnable(folderID, folderPath, deviceID string) error {
	folderID = strings.TrimSpace(folderID)
	folderPath = strings.TrimSpace(folderPath)
	deviceID = strings.TrimSpace(deviceID)
	if folderID == "" || folderPath == "" || deviceID == "" {
		return errors.New("folderID, folderPath and deviceID are required")
	}
	tok, err := loadDropboxToken()
	if err != nil {
		return errors.New("connect Dropbox first")
	}
	if strings.TrimSpace(tok.RefreshToken) == "" {
		return errors.New("reconnect Dropbox to grant offline access (needed for backups)")
	}
	appFolderPath := "/" + folderID

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := backendConnectDropbox(ctx, folderID, backendConnectReq{
		OwnerDeviceID: deviceID,
		RefreshToken:  tok.RefreshToken,
		AccountID:     tok.AccountID,
		AppFolderPath: appFolderPath,
	}); err != nil {
		return fmt.Errorf("link project: %w", err)
	}

	a.backup.addTarget(backupTarget{
		FolderID:      folderID,
		FolderPath:    folderPath,
		AppFolderPath: appFolderPath,
		DeviceID:      deviceID,
	})
	a.backup.kick(folderID)
	return nil
}

// BackupDisable turns off backup for a project and unlinks it from Dropbox on
// the backend. The bytes already in Dropbox are left untouched.
func (a *App) BackupDisable(folderID string) error {
	folderID = strings.TrimSpace(folderID)
	if folderID == "" {
		return errors.New("folderID is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := backendDisconnectDropbox(ctx, folderID); err != nil {
		return fmt.Errorf("unlink project: %w", err)
	}
	a.backup.removeTarget(folderID)
	return nil
}

// BackupStatus reports a project's backup state for the UI.
func (a *App) BackupStatus(folderID string) BackupStatusInfo {
	return a.backup.statusFor(strings.TrimSpace(folderID))
}

// BackupListEnabled returns the folder ids with backup enabled.
func (a *App) BackupListEnabled() []string {
	return a.backup.enabledIDs()
}

// BackupNow requests an immediate backup pass for one folder (or all when "").
func (a *App) BackupNow(folderID string) {
	a.backup.kick(strings.TrimSpace(folderID))
}

// ---- teammate-side: pull materials from a project's Dropbox backup ----

// backupDownloadHTTP fetches temporary links (plain GETs against Dropbox's
// CDN). No timeout: footage downloads run for minutes.
var backupDownloadHTTP = &http.Client{}

type backendMaterialOut struct {
	Path       string `json:"path"`
	ContentKey string `json:"contentKey"`
	SizeBytes  int64  `json:"sizeBytes"`
	Deleted    bool   `json:"deleted"`
}

func backendListMaterials(ctx context.Context, folderID string) ([]backendMaterialOut, error) {
	var resp struct {
		Materials []backendMaterialOut `json:"materials"`
	}
	if err := backendDo(ctx, http.MethodGet,
		"/v1/projects/"+url.PathEscape(folderID)+"/materials", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Materials, nil
}

func backendMaterialLink(ctx context.Context, folderID, p string) (string, error) {
	var resp struct {
		URL string `json:"url"`
	}
	if err := backendDo(ctx, http.MethodPost,
		"/v1/projects/"+url.PathEscape(folderID)+"/materials/link",
		map[string]string{"path": p}, &resp); err != nil {
		return "", err
	}
	if resp.URL == "" {
		return "", errors.New("backend returned empty link")
	}
	return resp.URL, nil
}

// BackupPullResult summarizes a teammate pull.
type BackupPullResult struct {
	Downloaded int    `json:"downloaded"`
	Skipped    int    `json:"skipped"`
	Failed     int    `json:"failed"`
	Bytes      int64  `json:"bytes"`
	Error      string `json:"error,omitempty"`
}

// BackupPull fetches a project's backup manifest and downloads any files the
// teammate is missing (or has at a different content hash) straight from the
// owner's Dropbox — no need for the owner's PC to be online. Downloaded bytes
// are hash-verified against the manifest before being placed, then the folder
// is rescanned so Syncthing reconciles them (identical content → no re-pull,
// no conflict).
func (a *App) BackupPull(folderID, folderPath string) (BackupPullResult, error) {
	folderID = strings.TrimSpace(folderID)
	folderPath = strings.TrimSpace(folderPath)
	if folderID == "" || folderPath == "" {
		return BackupPullResult{}, errors.New("folderID and folderPath are required")
	}
	sdb := a.currentSDB()
	if sdb == nil {
		return BackupPullResult{}, errors.New("daemon not ready")
	}
	ctx := context.Background()

	mats, err := backendListMaterials(ctx, folderID)
	if err != nil {
		return BackupPullResult{}, fmt.Errorf("fetch manifest: %w", err)
	}

	// What do we already have locally, by content hash?
	local := map[string]string{}
	seq, errFn := sdb.AllLocalFiles(folderID, protocol.LocalDeviceID)
	for fi, err := range itererr.Zip(seq, errFn) {
		if err != nil {
			break
		}
		if fi.IsDeleted() || fi.IsDirectory() || fi.IsSymlink() {
			continue
		}
		local[fi.Name] = hex.EncodeToString(fi.BlocksHash)
	}

	ffs := fs.NewFilesystem(fs.FilesystemTypeBasic, folderPath)
	var res BackupPullResult
	for _, m := range mats {
		if ctx.Err() != nil {
			break
		}
		if m.Deleted || m.Path == "" {
			continue
		}
		if local[m.Path] == m.ContentKey && m.ContentKey != "" {
			res.Skipped++ // already have identical content
			continue
		}
		linkURL, err := backendMaterialLink(ctx, folderID, m.Path)
		if err != nil {
			res.Failed++
			continue
		}
		n, err := a.pullOneMaterial(ctx, folderID, ffs, folderPath, m, linkURL)
		if err != nil {
			res.Failed++
			continue
		}
		res.Downloaded++
		res.Bytes += n
	}

	// Nudge a rescan so the freshly-placed files enter the index promptly and
	// reconcile against any peers by hash.
	if res.Downloaded > 0 {
		if in := a.currentInternals(); in != nil {
			_ = in.ScanFolderSubdirs(folderID, nil)
		}
	}
	return res, nil
}

// pullOneMaterial downloads one file to a Syncthing temp name (which the
// scanner ignores), verifies its content hash matches the manifest, then
// atomically renames it into place. Returns the bytes written.
func (a *App) pullOneMaterial(ctx context.Context, folderID string, ffs fs.Filesystem, folderPath string, m backendMaterialOut, linkURL string) (int64, error) {
	relOS := filepath.FromSlash(m.Path)
	tmpRel := fs.TempName(relOS)
	finalAbs := filepath.Join(folderPath, relOS)
	tmpAbs := filepath.Join(folderPath, tmpRel)

	if err := os.MkdirAll(filepath.Dir(finalAbs), 0o755); err != nil {
		return 0, err
	}

	n, err := a.downloadTo(ctx, linkURL, tmpAbs, m.Path, m.SizeBytes)
	if err != nil {
		_ = os.Remove(tmpAbs)
		return 0, err
	}
	if m.SizeBytes > 0 && n != m.SizeBytes {
		_ = os.Remove(tmpAbs)
		return 0, fmt.Errorf("size mismatch: got %d want %d", n, m.SizeBytes)
	}

	// Verify the bytes before exposing them to the scanner. A corrupt or
	// truncated download must never reach the index — a wrong-content file
	// with a concurrent version could turn into a .sync-conflict.
	if m.ContentKey != "" {
		blocks, err := scanner.HashFile(ctx, folderID, ffs, tmpRel, protocol.BlockSize(n), nil)
		if err != nil {
			_ = os.Remove(tmpAbs)
			return 0, fmt.Errorf("verify hash: %w", err)
		}
		if hex.EncodeToString(protocol.BlocksHash(blocks)) != m.ContentKey {
			_ = os.Remove(tmpAbs)
			return 0, errors.New("content hash mismatch after download")
		}
	}

	if err := os.Rename(tmpAbs, finalAbs); err != nil {
		_ = os.Remove(tmpAbs)
		return 0, err
	}
	return n, nil
}

func (a *App) downloadTo(ctx context.Context, linkURL, destAbs, displayName string, size int64) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, linkURL, nil)
	if err != nil {
		return 0, err
	}
	resp, err := backupDownloadHTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return 0, fmt.Errorf("download (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	out, err := os.Create(destAbs)
	if err != nil {
		return 0, err
	}
	buf := make([]byte, 1<<20)
	var done int64
	for {
		if ctx.Err() != nil {
			out.Close()
			return done, ctx.Err()
		}
		nr, rerr := resp.Body.Read(buf)
		if nr > 0 {
			if _, werr := out.Write(buf[:nr]); werr != nil {
				out.Close()
				return done, werr
			}
			done += int64(nr)
			a.emitBackup("backup:progress", map[string]any{
				"name":       displayName,
				"bytesDone":  done,
				"bytesTotal": size,
				"direction":  "download",
			})
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			out.Close()
			return done, rerr
		}
	}
	if err := out.Close(); err != nil {
		return done, err
	}
	return done, nil
}

// currentInternals returns the daemon's Internals accessor, or nil if the
// daemon isn't up.
func (a *App) currentInternals() *syncthing.Internals {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.daemonH == nil || a.daemonH.app == nil {
		return nil
	}
	return a.daemonH.app.Internals
}

// emitBackup forwards a backup event to the frontend when the WebView is up.
func (a *App) emitBackup(event string, payload any) {
	a.mu.RLock()
	ctx := a.ctx
	a.mu.RUnlock()
	if ctx == nil {
		return
	}
	runtime.EventsEmit(ctx, event, payload)
}

// currentSDB returns the live daemon database, or nil if the daemon isn't up.
func (a *App) currentSDB() db.DB {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.daemonH == nil {
		return nil
	}
	return a.daemonH.sdb
}
