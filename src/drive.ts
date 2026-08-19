import { accessToken } from './google-auth';
import { config } from './config';

/**
 * The Google Drive v3 REST calls Stage 5 needs: create a folder in the Shared
 * Drive, grant a person access, and recursively copy a template folder's
 * contents into the student's folder.
 *
 * Every call carries supportsAllDrives=true (and listing carries
 * includeItemsFromAllDrives=true) because the folders live in a Shared Drive,
 * not the service account's My Drive.
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';

export class DriveError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.details = details;
  }
}

async function call<T>(
  method: 'GET' | 'POST',
  pathname: string,
  init: { query?: Record<string, string>; body?: unknown } = {}
): Promise<T> {
  const token = await accessToken();
  const query = new URLSearchParams({
    supportsAllDrives: 'true',
    ...init.query,
  });
  const res = await fetch(`${API}${pathname}?${query}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new DriveError(
      `Drive ${method} ${pathname} returned ${res.status}: ${text.slice(0, 500)}`,
      res.status,
      data
    );
  }
  return data as T;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
}

/** Create a folder under `parentId` and return it (with a shareable link). */
export async function createFolder(
  name: string,
  parentId: string
): Promise<{ id: string; url: string }> {
  const file = await call<DriveFile>('POST', '/files', {
    query: { fields: 'id,webViewLink' },
    body: { name, mimeType: FOLDER_MIME, parents: [parentId] },
  });
  return {
    id: file.id,
    url: file.webViewLink ?? `https://drive.google.com/drive/folders/${file.id}`,
  };
}

/** Where new student folders go: the configured sub-folder, else the drive root. */
export function studentsParentId(): string {
  return config.google.studentsParentFolderId || config.google.sharedDriveId;
}

/**
 * Grant a person a role on a file/folder. Sends Google's notification email so
 * the family gets the "shared with you" mail. Idempotent enough for our use:
 * re-granting the same person the same role is accepted by Drive.
 */
export async function grantAccess(
  fileId: string,
  email: string,
  role: 'reader' | 'commenter' | 'writer'
): Promise<void> {
  await call('POST', `/files/${encodeURIComponent(fileId)}/permissions`, {
    query: { sendNotificationEmail: 'true' },
    body: { type: 'user', role, emailAddress: email },
  });
}

/** List the direct children of a folder (non-trashed). */
async function listChildren(folderId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const query: Record<string, string> = {
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType)',
      includeItemsFromAllDrives: 'true',
      pageSize: '1000',
    };
    if (pageToken) query.pageToken = pageToken;
    const page = await call<{ files?: DriveFile[]; nextPageToken?: string }>(
      'GET',
      '/files',
      { query }
    );
    out.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** Copy a single file into `destParentId`, keeping its name. */
async function copyFile(fileId: string, name: string, destParentId: string): Promise<void> {
  await call('POST', `/files/${encodeURIComponent(fileId)}/copy`, {
    query: { fields: 'id' },
    body: { name, parents: [destParentId] },
  });
}

/**
 * Recursively copy the CONTENTS of `sourceFolderId` into `destFolderId`:
 * files are copied; sub-folders are recreated and their contents copied in
 * turn. Drive has no server-side recursive folder copy, so we walk the tree.
 */
export async function copyFolderContents(
  sourceFolderId: string,
  destFolderId: string
): Promise<void> {
  const children = await listChildren(sourceFolderId);
  for (const child of children) {
    if (child.mimeType === FOLDER_MIME) {
      const sub = await createFolder(child.name, destFolderId);
      await copyFolderContents(child.id, sub.id);
    } else {
      await copyFile(child.id, child.name, destFolderId);
    }
  }
}
