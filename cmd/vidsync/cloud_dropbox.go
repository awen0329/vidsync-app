// cloud_dropbox.go implements a one-time import/export bridge to Dropbox,
// bound into the React app as window.go.main.App.Dropbox*.
//
// Design: everything runs in the desktop process. A vidsync project is just a
// local folder the daemon syncs, so importing means downloading the chosen
// Dropbox files into that folder (the daemon then distributes them); exporting
// means uploading local project files up to Dropbox. The OAuth token lives
// encrypted next to the auth token (storeSecret).
//
// Auth is the OAuth2 "PKCE" flow for installed apps: we open the system
// browser to Dropbox's consent page, catch the redirect on a fixed loopback
// port, and exchange the code for an offline (refreshable) token. No client
// secret is needed or shipped — the app key is public.

package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	dropboxRedirectPort = "53682"
	dropboxRedirectURI  = "http://localhost:53682/"
	dropboxScopes       = "account_info.read files.metadata.read files.content.read files.content.write"
	dropboxTokenFile    = "dropbox.bin"
	dropboxChunkSize    = 16 << 20 // 16 MiB upload-session chunks
)

// dropboxAppKey is the Dropbox app's public "App key" (PKCE client). Set it at
// build time with -ldflags "-X main.dropboxAppKey=<key>" or at runtime via the
// VIDSYNC_DROPBOX_APP_KEY env var.
var dropboxAppKey = ""

func dropboxClientID() string {
	if k := strings.TrimSpace(os.Getenv("VIDSYNC_DROPBOX_APP_KEY")); k != "" {
		return k
	}
	return strings.TrimSpace(dropboxAppKey)
}

// dropboxMu serialises token refresh so two concurrent calls don't both spend
// the refresh token / race the on-disk file.
var dropboxMu sync.Mutex

// dropboxHTTP has no overall timeout: content up/downloads can run for minutes
// on large footage. Per-attempt failures surface as request errors instead.
var dropboxHTTP = &http.Client{}

type dropboxToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	Expiry       time.Time `json:"expiry"`
	AccountID    string    `json:"account_id,omitempty"`
}

// --- types exposed to JS ---

// DropboxAccount is the connection status shown in the UI.
type DropboxAccount struct {
	Connected bool `json:"connected"`
	// Configured is false when no app key is baked in, so the UI can hide the
	// feature rather than show a broken connect button.
	Configured bool   `json:"configured"`
	Email      string `json:"email,omitempty"`
	Name       string `json:"name,omitempty"`
}

// DropboxEntry is one row in the import browser.
type DropboxEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"` // Dropbox path (e.g. "/Footage/clip.mov")
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// --- token persistence ---

func loadDropboxToken() (*dropboxToken, error) {
	raw, err := loadSecret(dropboxTokenFile)
	if err != nil {
		return nil, err
	}
	var t dropboxToken
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

func saveDropboxToken(t *dropboxToken) error {
	raw, err := json.Marshal(t)
	if err != nil {
		return err
	}
	return storeSecret(dropboxTokenFile, raw)
}

// --- OAuth ---

func pkcePair() (verifier, challenge string) {
	b := make([]byte, 64)
	_, _ = rand.Read(b)
	verifier = base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return verifier, challenge
}

const dropboxDoneHTML = `<!doctype html><meta charset="utf-8"><title>Vidsync</title>
<body style="font-family:system-ui;background:#0b0f14;color:#e6edf3;display:flex;
height:100vh;margin:0;align-items:center;justify-content:center">
<div style="text-align:center"><h2>Dropbox connected</h2>
<p>You can close this tab and return to Vidsync.</p></div>`

// DropboxConnect runs the OAuth consent flow and stores the resulting token.
func (a *App) DropboxConnect() (DropboxAccount, error) {
	clientID := dropboxClientID()
	if clientID == "" {
		return DropboxAccount{}, errors.New("Dropbox isn't configured in this build (missing app key)")
	}

	verifier, challenge := pkcePair()

	ln, err := net.Listen("tcp", "127.0.0.1:"+dropboxRedirectPort)
	if err != nil {
		return DropboxAccount{}, fmt.Errorf("couldn't open the loopback port %s for the Dropbox sign-in redirect: %w", dropboxRedirectPort, err)
	}
	codeCh := make(chan string, 1)
	errCh := make(chan string, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if e := q.Get("error"); e != "" {
			select {
			case errCh <- e:
			default:
			}
			io.WriteString(w, "Dropbox authorization failed. You can close this window.")
			return
		}
		code := q.Get("code")
		if code == "" {
			http.NotFound(w, r)
			return
		}
		select {
		case codeCh <- code:
		default:
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, dropboxDoneHTML)
	})}
	go srv.Serve(ln)
	defer srv.Close()

	authURL := "https://www.dropbox.com/oauth2/authorize?" + url.Values{
		"client_id":             {clientID},
		"response_type":         {"code"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"token_access_type":     {"offline"},
		"scope":                 {dropboxScopes},
		"redirect_uri":          {dropboxRedirectURI},
	}.Encode()
	runtime.BrowserOpenURL(a.ctx, authURL)

	var code string
	select {
	case code = <-codeCh:
	case e := <-errCh:
		return DropboxAccount{}, fmt.Errorf("Dropbox authorization was denied: %s", e)
	case <-time.After(5 * time.Minute):
		return DropboxAccount{}, errors.New("timed out waiting for Dropbox authorization")
	}

	tok, err := dropboxExchange(clientID, code, verifier)
	if err != nil {
		return DropboxAccount{}, err
	}
	if err := saveDropboxToken(tok); err != nil {
		return DropboxAccount{}, err
	}
	return a.DropboxStatus()
}

func dropboxExchange(clientID, code, verifier string) (*dropboxToken, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {verifier},
		"client_id":     {clientID},
		"redirect_uri":  {dropboxRedirectURI},
	}
	resp, err := dropboxHTTP.PostForm("https://api.dropboxapi.com/oauth2/token", form)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Dropbox token exchange failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var r struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		AccountID    string `json:"account_id"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	return &dropboxToken{
		AccessToken:  r.AccessToken,
		RefreshToken: r.RefreshToken,
		Expiry:       time.Now().Add(time.Duration(r.ExpiresIn) * time.Second),
		AccountID:    r.AccountID,
	}, nil
}

// validAccessToken returns a non-expired access token, refreshing it via the
// stored refresh token when needed.
func validAccessToken() (string, error) {
	dropboxMu.Lock()
	defer dropboxMu.Unlock()

	t, err := loadDropboxToken()
	if err != nil {
		return "", err
	}
	if time.Now().Before(t.Expiry.Add(-60 * time.Second)) {
		return t.AccessToken, nil
	}
	if t.RefreshToken == "" {
		return t.AccessToken, nil // legacy token without offline access
	}
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {t.RefreshToken},
		"client_id":     {dropboxClientID()},
	}
	resp, err := dropboxHTTP.PostForm("https://api.dropboxapi.com/oauth2/token", form)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Dropbox token refresh failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var r struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return "", err
	}
	t.AccessToken = r.AccessToken
	t.Expiry = time.Now().Add(time.Duration(r.ExpiresIn) * time.Second)
	_ = saveDropboxToken(t)
	return t.AccessToken, nil
}

// DropboxStatus reports whether Dropbox is configured/connected and, if so,
// the account identity. Never errors for the "not connected" case.
func (a *App) DropboxStatus() (DropboxAccount, error) {
	if dropboxClientID() == "" {
		return DropboxAccount{Configured: false}, nil
	}
	if _, err := loadDropboxToken(); err != nil {
		return DropboxAccount{Configured: true, Connected: false}, nil
	}
	tok, err := validAccessToken()
	if err != nil || tok == "" {
		return DropboxAccount{Configured: true, Connected: false}, nil
	}
	acct := DropboxAccount{Configured: true, Connected: true}
	if name, email, err := dropboxCurrentAccount(tok); err == nil {
		acct.Name, acct.Email = name, email
	}
	return acct, nil
}

// DropboxDisconnect revokes and forgets the stored token.
func (a *App) DropboxDisconnect() error {
	if tok, err := validAccessToken(); err == nil && tok != "" {
		req, _ := http.NewRequest(http.MethodPost, "https://api.dropboxapi.com/2/auth/token/revoke", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		if resp, err := dropboxHTTP.Do(req); err == nil {
			resp.Body.Close()
		}
	}
	return deleteSecret(dropboxTokenFile)
}

// --- API helpers ---

func dropboxCurrentAccount(tok string) (name, email string, err error) {
	// This RPC takes a literal null body.
	req, _ := http.NewRequest(http.MethodPost, "https://api.dropboxapi.com/2/users/get_current_account", strings.NewReader("null"))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := dropboxHTTP.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("get_current_account (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var r struct {
		Email string `json:"email"`
		Name  struct {
			DisplayName string `json:"display_name"`
		} `json:"name"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return "", "", err
	}
	return r.Name.DisplayName, r.Email, nil
}

// dropboxRPC posts a JSON arg to an api.dropboxapi.com RPC endpoint and decodes
// the JSON response into out.
func dropboxRPC(tok, endpoint string, arg any, out any) error {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(arg); err != nil {
		return err
	}
	req, _ := http.NewRequest(http.MethodPost, endpoint, &buf)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := dropboxHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s (%d): %s", path.Base(endpoint), resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(body, out)
}

type dropboxListResp struct {
	Entries []struct {
		Tag         string `json:".tag"`
		Name        string `json:"name"`
		PathDisplay string `json:"path_display"`
		PathLower   string `json:"path_lower"`
		Size        int64  `json:"size"`
	} `json:"entries"`
	Cursor  string `json:"cursor"`
	HasMore bool   `json:"has_more"`
}

// DropboxList lists a Dropbox folder for the import browser. Pass "" for the
// account root. Folders sort before files; both alphabetical.
func (a *App) DropboxList(dbPath string) ([]DropboxEntry, error) {
	tok, err := validAccessToken()
	if err != nil {
		return nil, err
	}
	// Dropbox wants "" for the root, "/Sub/Dir" otherwise.
	if dbPath == "/" {
		dbPath = ""
	}
	var resp dropboxListResp
	if err := dropboxRPC(tok, "https://api.dropboxapi.com/2/files/list_folder", map[string]any{
		"path":                           dbPath,
		"recursive":                      false,
		"include_non_downloadable_files": false,
		"include_mounted_folders":        true,
	}, &resp); err != nil {
		return nil, err
	}
	out := collectEntries(resp)
	for resp.HasMore {
		var cont dropboxListResp
		if err := dropboxRPC(tok, "https://api.dropboxapi.com/2/files/list_folder/continue", map[string]any{
			"cursor": resp.Cursor,
		}, &cont); err != nil {
			return nil, err
		}
		out = append(out, collectEntries(cont)...)
		resp.HasMore, resp.Cursor = cont.HasMore, cont.Cursor
	}
	return out, nil
}

func collectEntries(r dropboxListResp) []DropboxEntry {
	out := make([]DropboxEntry, 0, len(r.Entries))
	for _, e := range r.Entries {
		p := e.PathDisplay
		if p == "" {
			p = e.PathLower
		}
		out = append(out, DropboxEntry{
			Name:  e.Name,
			Path:  p,
			IsDir: e.Tag == "folder",
			Size:  e.Size,
		})
	}
	return out
}

// --- import (download) ---

// DropboxImport downloads the given Dropbox file paths into destDir on disk
// (the project's local folder), emitting "dropbox:progress" events.
func (a *App) DropboxImport(destDir string, paths []string) error {
	if strings.TrimSpace(destDir) == "" {
		return errors.New("no destination folder")
	}
	tok, err := validAccessToken()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return err
	}
	total := len(paths)
	for i, p := range paths {
		name := path.Base(p)
		a.emitDropbox("import", i, total, name, 0, 0)
		dst := filepath.Join(destDir, name)
		if err := a.dropboxDownload(tok, p, dst, i, total); err != nil {
			a.emitDropbox("error", i, total, name, 0, 0)
			return fmt.Errorf("import %q: %w", name, err)
		}
	}
	a.emitDropbox("import-done", total, total, "", 0, 0)
	return nil
}

func (a *App) dropboxDownload(tok, dbPath, dst string, idx, total int) error {
	arg, _ := json.Marshal(map[string]string{"path": dbPath})
	req, _ := http.NewRequest(http.MethodPost, "https://content.dropboxapi.com/2/files/download", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Dropbox-API-Arg", string(arg))
	resp, err := dropboxHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("download (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	// Write to a temp file then rename so a partial download never lands as a
	// finished file the daemon would start syncing.
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	cw := &countingWriter{a: a, name: path.Base(dbPath), idx: idx, total: total, totalBytes: resp.ContentLength}
	_, err = io.Copy(io.MultiWriter(f, cw), resp.Body)
	closeErr := f.Close()
	if err != nil {
		os.Remove(tmp)
		return err
	}
	if closeErr != nil {
		os.Remove(tmp)
		return closeErr
	}
	return os.Rename(tmp, dst)
}

// --- export (upload) ---

// DropboxExport uploads project files (relative paths under srcDir) to the
// Dropbox folder dropboxDest, emitting "dropbox:progress" events. Uses an
// upload session so files of any size work.
func (a *App) DropboxExport(srcDir string, relPaths []string, dropboxDest string) error {
	tok, err := validAccessToken()
	if err != nil {
		return err
	}
	dest := normalizeDropboxDir(dropboxDest)
	total := len(relPaths)
	for i, rel := range relPaths {
		local := filepath.Join(srcDir, filepath.FromSlash(rel))
		name := filepath.Base(local)
		dbPath := dest + "/" + name
		a.emitDropbox("export", i, total, name, 0, 0)
		if err := a.dropboxUpload(tok, local, dbPath, i, total); err != nil {
			a.emitDropbox("error", i, total, name, 0, 0)
			return fmt.Errorf("export %q: %w", name, err)
		}
	}
	a.emitDropbox("export-done", total, total, "", 0, 0)
	return nil
}

// normalizeDropboxDir returns a Dropbox dir path with a leading slash and no
// trailing slash; "" / "/" mean the account root (empty string for the API).
func normalizeDropboxDir(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimRight(p, "/")
	if p == "" {
		return ""
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return p
}

func (a *App) dropboxUpload(tok, local, dbPath string, idx, total int) error {
	f, err := os.Open(local)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	size := info.Size()
	name := filepath.Base(local)

	// Start an empty upload session, append the file in chunks, then finish
	// with the commit (path + mode). Works for any size, including 0 bytes.
	sessionID, err := dropboxSessionStart(tok)
	if err != nil {
		return err
	}
	buf := make([]byte, dropboxChunkSize)
	var offset int64
	for {
		n, rerr := io.ReadFull(f, buf)
		if n > 0 {
			if err := dropboxSessionAppend(tok, sessionID, offset, buf[:n]); err != nil {
				return err
			}
			offset += int64(n)
			a.emitDropbox("export", idx, total, name, offset, size)
		}
		if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	return dropboxSessionFinish(tok, sessionID, offset, dbPath)
}

func dropboxContentReq(tok, endpoint, apiArg string, body io.Reader) (*http.Response, error) {
	req, _ := http.NewRequest(http.MethodPost, endpoint, body)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Dropbox-API-Arg", apiArg)
	req.Header.Set("Content-Type", "application/octet-stream")
	return dropboxHTTP.Do(req)
}

func dropboxSessionStart(tok string) (string, error) {
	resp, err := dropboxContentReq(tok, "https://content.dropboxapi.com/2/files/upload_session/start", `{"close":false}`, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("upload_session/start (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var r struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return "", err
	}
	return r.SessionID, nil
}

func dropboxSessionAppend(tok, sessionID string, offset int64, chunk []byte) error {
	arg, _ := json.Marshal(map[string]any{
		"cursor": map[string]any{"session_id": sessionID, "offset": offset},
		"close":  false,
	})
	resp, err := dropboxContentReq(tok, "https://content.dropboxapi.com/2/files/upload_session/append_v2", string(arg), bytes.NewReader(chunk))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("upload_session/append (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	io.Copy(io.Discard, resp.Body)
	return nil
}

func dropboxSessionFinish(tok, sessionID string, offset int64, dbPath string) error {
	arg, _ := json.Marshal(map[string]any{
		"cursor": map[string]any{"session_id": sessionID, "offset": offset},
		"commit": map[string]any{"path": dbPath, "mode": "add", "autorename": true, "mute": false},
	})
	resp, err := dropboxContentReq(tok, "https://content.dropboxapi.com/2/files/upload_session/finish", string(arg), nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upload_session/finish (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

// --- progress plumbing ---

func (a *App) emitDropbox(phase string, current, total int, name string, bytesDone, bytesTotal int64) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, "dropbox:progress", map[string]any{
		"phase":      phase,
		"current":    current,
		"total":      total,
		"name":       name,
		"bytesDone":  bytesDone,
		"bytesTotal": bytesTotal,
	})
}

// countingWriter emits byte-level progress for a single download.
type countingWriter struct {
	a          *App
	name       string
	idx, total int
	totalBytes int64
	done       int64
	lastEmit   time.Time
}

func (w *countingWriter) Write(p []byte) (int, error) {
	w.done += int64(len(p))
	// Throttle to ~10/s so we don't flood the event bus on fast links.
	if time.Since(w.lastEmit) > 100*time.Millisecond {
		w.lastEmit = time.Now()
		w.a.emitDropbox("import", w.idx, w.total, w.name, w.done, w.totalBytes)
	}
	return len(p), nil
}
