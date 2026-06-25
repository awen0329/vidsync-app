export namespace main {
	
	export class BackupPullResult {
	    downloaded: number;
	    skipped: number;
	    failed: number;
	    bytes: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new BackupPullResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.downloaded = source["downloaded"];
	        this.skipped = source["skipped"];
	        this.failed = source["failed"];
	        this.bytes = source["bytes"];
	        this.error = source["error"];
	    }
	}
	export class BackupStatusInfo {
	    enabled: boolean;
	    uploading: boolean;
	    lastBackupUnixMs: number;
	    lastError: string;
	    fileCount: number;
	
	    static createFrom(source: any = {}) {
	        return new BackupStatusInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.uploading = source["uploading"];
	        this.lastBackupUnixMs = source["lastBackupUnixMs"];
	        this.lastError = source["lastError"];
	        this.fileCount = source["fileCount"];
	    }
	}
	export class DropboxAccount {
	    connected: boolean;
	    configured: boolean;
	    email?: string;
	    name?: string;
	
	    static createFrom(source: any = {}) {
	        return new DropboxAccount(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connected = source["connected"];
	        this.configured = source["configured"];
	        this.email = source["email"];
	        this.name = source["name"];
	    }
	}
	export class DropboxEntry {
	    name: string;
	    path: string;
	    isDir: boolean;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new DropboxEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.isDir = source["isDir"];
	        this.size = source["size"];
	    }
	}

}

