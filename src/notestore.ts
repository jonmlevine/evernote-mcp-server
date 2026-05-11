import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  appendAttachmentToEnml,
  attachmentBodyHash,
  attachmentBodyHashHex,
  inferAttachmentMimeType,
  normalizeAttachmentData,
} from "./attachments.js";
import type {
  ApiResponse,
  Attachment,
  AttachmentData,
  AuthTokens,
  CreateAttachmentParams,
  CreateNotebookParams,
  CreateTagParams,
  Notebook,
  Note,
  SearchResult,
  Tag,
  UpdateNoteParams,
} from "./types.js";

const require = createRequire(import.meta.url);
const thrift = require("thrift");
const NoteStore = require(
  fileURLToPath(new URL("../vendor/evernote-thrift/NoteStore.js", import.meta.url))
);
const Types = require(
  fileURLToPath(new URL("../vendor/evernote-thrift/Types_types.js", import.meta.url))
);
const NoteStoreTypes = require(
  fileURLToPath(new URL("../vendor/evernote-thrift/NoteStore_types.js", import.meta.url))
);
const Errors = require(
  fileURLToPath(new URL("../vendor/evernote-thrift/Errors_types.js", import.meta.url))
);

const EDAM_ERROR_CODES_BY_VALUE = new Map<number, string>(
  Object.entries(Errors.EDAMErrorCode || {}).map(([name, value]) => [Number(value), name])
);

type RawNotebook = {
  guid?: string;
  name?: string;
  stack?: string;
  defaultNotebook?: boolean;
  serviceCreated?: number;
  serviceUpdated?: number;
  created?: number;
  updated?: number;
  sharedNotebookIds?: string[];
};

type RawTag = {
  guid?: string;
  name?: string;
  parentGuid?: string;
};

type RawNote = {
  guid?: string;
  title?: string;
  content?: string;
  created?: number;
  updated?: number;
  deleted?: number;
  notebookGuid?: string;
  tagGuids?: string[];
  attributes?: Note["attributes"];
  resources?: RawResource[];
  [key: string]: unknown;
};

type RawNoteMetadata = {
  guid?: string;
  title?: string;
  created?: number;
  updated?: number;
  deleted?: number;
  notebookGuid?: string;
  tagGuids?: string[];
};

type RawNotesMetadataList = {
  notes?: RawNoteMetadata[];
};

type RawResource = {
  guid?: string;
  noteGuid?: string;
  data?: RawData;
  mime?: string;
  width?: number;
  height?: number;
  active?: boolean;
  attributes?: RawResourceAttributes;
  updateSequenceNum?: number;
  [key: string]: unknown;
};

type RawData = {
  bodyHash?: unknown;
  size?: number;
  body?: unknown;
};

type RawResourceAttributes = {
  fileName?: string;
  attachment?: boolean;
};

export type NoteStoreResourceMetadata = {
  id: string;
  noteId?: string;
};

function noteStoreUrl(tokens: AuthTokens): URL {
  return new URL(`https://www.evernote.com/shard/${tokens.shard}/notestore`);
}

function normalizeNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "object" && value && "toNumber" in value) {
    const candidate = (value as { toNumber?: () => number }).toNumber;
    if (typeof candidate === "function") return candidate.call(value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapNotebook(notebook: RawNotebook): Notebook {
  return {
    id: notebook.guid || "",
    name: notebook.name || "",
    stack: notebook.stack || undefined,
    defaultNotebook: notebook.defaultNotebook,
    created: normalizeNumber(notebook.serviceCreated ?? notebook.created),
    updated: normalizeNumber(notebook.serviceUpdated ?? notebook.updated),
    sharedNotebookIds: notebook.sharedNotebookIds || undefined,
  };
}

function mapTag(tag: RawTag): Tag {
  return {
    id: tag.guid || "",
    name: tag.name || "",
    parentId: tag.parentGuid || undefined,
  };
}

function mapNote(note: RawNote): Note {
  return {
    id: note.guid || "",
    title: note.title || "",
    content: note.content,
    created: normalizeNumber(note.created),
    updated: normalizeNumber(note.updated),
    deleted: normalizeNumber(note.deleted),
    notebookId: note.notebookGuid || undefined,
    tagIds: note.tagGuids || undefined,
    attributes: note.attributes || undefined,
    resources: note.resources?.map(mapResource),
  };
}

function mapNoteMetadata(note: RawNoteMetadata): SearchResult {
  return {
    noteId: note.guid || "",
    title: note.title || "",
    notebookId: note.notebookGuid || undefined,
    created: normalizeNumber(note.created),
    updated: normalizeNumber(note.updated),
  };
}

export function updateRequiresNoteContent(params: UpdateNoteParams): boolean {
  return params.content !== undefined;
}

function normalizeBuffer(value: unknown): Buffer | undefined {
  if (value == null) return undefined;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "binary");
  if (typeof value === "object" && "data" in value) {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) return Buffer.from(data);
  }
  return undefined;
}

function mapResource(resource: RawResource): Attachment {
  const bodyHash = normalizeBuffer(resource.data?.bodyHash);
  return {
    id: resource.guid || "",
    noteId: resource.noteGuid || "",
    mime: resource.mime || "application/octet-stream",
    width: normalizeNumber(resource.width),
    height: normalizeNumber(resource.height),
    filename: resource.attributes?.fileName || undefined,
    size: normalizeNumber(resource.data?.size),
    hash: bodyHash?.toString("hex"),
    active: resource.active,
  };
}

function mapResourceData(resource: RawResource, body?: Buffer): AttachmentData {
  const mapped: AttachmentData = mapResource(resource);
  if (body) {
    mapped.data = body.toString("base64");
    mapped.encoding = "base64";
    mapped.size = body.length;
  }
  return mapped;
}

async function callNoteStore<T>(
  tokens: AuthTokens,
  method: string,
  ...args: unknown[]
): Promise<T> {
  const url = noteStoreUrl(tokens);
  const connection = thrift.createHttpConnection(url.hostname, url.port || 443, {
    transport: thrift.TBufferedTransport,
    protocol: thrift.TBinaryProtocol,
    path: url.pathname,
    headers: {
      "User-Agent": "evernote-unofficial-api/3.1.0",
    },
    https: true,
  });
  const client = thrift.createHttpClient(NoteStore, connection) as Record<string, unknown>;

  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        connection.removeAllListeners?.();
        connection.end?.();
      } catch {
        // ignore cleanup errors
      }
      fn();
    };

    connection.on?.("error", (error: unknown) => {
      finish(() => reject(error));
    });

    const handler = client[method];
    if (typeof handler !== "function") {
      finish(() => reject(new Error(`Unsupported NoteStore method: ${method}`)));
      return;
    }

    try {
      (handler as (...callArgs: unknown[]) => void).apply(client, [
        tokens.legacyToken,
        ...args,
        (error: unknown, result: T) => {
          if (error) {
            finish(() => reject(error));
            return;
          }
          finish(() => resolve(result));
        },
      ]);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

export function formatNoteStoreError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const details = error as {
    name?: string;
    message?: string;
    errorCode?: number;
    parameter?: string;
    rateLimitDuration?: number;
  };
  const fallback = details.message || details.name || "Unknown NoteStore error";
  if (!details.name?.startsWith("EDAM") || typeof details.errorCode !== "number") {
    return fallback;
  }

  const codeName = EDAM_ERROR_CODES_BY_VALUE.get(details.errorCode) || "UNKNOWN";
  const fields = [`${details.name}: ${codeName} (${details.errorCode})`];
  if (details.parameter) fields.push(`parameter=${details.parameter}`);
  if (typeof details.rateLimitDuration === "number") {
    fields.push(`rateLimitDuration=${details.rateLimitDuration}`);
  }
  return fields.join("; ");
}

function errorResponse<T>(error: unknown, status = 500): ApiResponse<T> {
  const message = formatNoteStoreError(error);
  return {
    ok: false,
    status,
    error: message,
  };
}

export async function listNotebooksViaNoteStore(
  tokens: AuthTokens
): Promise<ApiResponse<Notebook[]>> {
  try {
    const notebooks = await callNoteStore<RawNotebook[]>(tokens, "listNotebooks");
    return { ok: true, status: 200, data: (notebooks || []).map(mapNotebook) };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function getNotebookViaNoteStore(
  tokens: AuthTokens,
  notebookId: string
): Promise<ApiResponse<Notebook>> {
  try {
    const notebook = await callNoteStore<RawNotebook>(tokens, "getNotebook", notebookId);
    return { ok: true, status: 200, data: mapNotebook(notebook) };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function createNotebookViaNoteStore(
  tokens: AuthTokens,
  params: CreateNotebookParams
): Promise<ApiResponse<Notebook>> {
  try {
    const notebook = await callNoteStore<RawNotebook>(tokens, "createNotebook", {
      name: params.name,
      stack: params.stack,
    });
    return { ok: true, status: 200, data: mapNotebook(notebook) };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function deleteNotebookViaNoteStore(
  tokens: AuthTokens,
  notebookId: string
): Promise<ApiResponse<void>> {
  try {
    await callNoteStore(tokens, "expungeNotebook", notebookId);
    return { ok: true, status: 200, data: undefined };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function listTagsViaNoteStore(
  tokens: AuthTokens
): Promise<ApiResponse<Tag[]>> {
  try {
    const tags = await callNoteStore<RawTag[]>(tokens, "listTags");
    return { ok: true, status: 200, data: (tags || []).map(mapTag) };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function listNotesViaNoteStore(
  tokens: AuthTokens,
  maxResults = 50
): Promise<ApiResponse<SearchResult[]>> {
  try {
    const filter = new NoteStoreTypes.NoteFilter({
      order: Types.NoteSortOrder.UPDATED,
      ascending: false,
      inactive: false,
    });
    const resultSpec = new NoteStoreTypes.NotesMetadataResultSpec({
      includeTitle: true,
      includeCreated: true,
      includeUpdated: true,
      includeDeleted: true,
      includeNotebookGuid: true,
      includeTagGuids: true,
    });
    const notes = await callNoteStore<RawNotesMetadataList>(
      tokens,
      "findNotesMetadata",
      filter,
      0,
      maxResults,
      resultSpec
    );

    return {
      ok: true,
      status: 200,
      data: (notes.notes || []).map(mapNoteMetadata),
    };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function createTagViaNoteStore(
  tokens: AuthTokens,
  params: CreateTagParams
): Promise<ApiResponse<Tag>> {
  try {
    const tag = await callNoteStore<RawTag>(tokens, "createTag", {
      name: params.name,
      parentGuid: params.parentId,
    });
    return { ok: true, status: 200, data: mapTag(tag) };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function getNoteViaNoteStore(
  tokens: AuthTokens,
  noteId: string,
  includeContent = true
): Promise<ApiResponse<Note>> {
  try {
    const note = await callNoteStore<RawNote>(
      tokens,
      "getNote",
      noteId,
      includeContent,
      false,
      false,
      false
    );
    return { ok: true, status: 200, data: mapNote(note) };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function getResourceMetadataViaNoteStore(
  tokens: AuthTokens,
  resourceId: string
): Promise<ApiResponse<NoteStoreResourceMetadata>> {
  try {
    const resource = await callNoteStore<RawResource>(
      tokens,
      "getResource",
      resourceId,
      false,
      false,
      false,
      false
    );
    return {
      ok: true,
      status: 200,
      data: {
        id: resource.guid || resourceId,
        noteId: resource.noteGuid || undefined,
      },
    };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function listAttachmentsViaNoteStore(
  tokens: AuthTokens,
  noteId: string
): Promise<ApiResponse<Attachment[]>> {
  try {
    const note = await callNoteStore<RawNote>(
      tokens,
      "getNote",
      noteId,
      false,
      false,
      false,
      false
    );
    return {
      ok: true,
      status: 200,
      data: (note.resources || []).map(mapResource),
    };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function getAttachmentViaNoteStore(
  tokens: AuthTokens,
  resourceId: string,
  options: { includeData?: boolean } = {}
): Promise<ApiResponse<AttachmentData>> {
  const includeData = options.includeData ?? true;

  try {
    const resource = await callNoteStore<RawResource>(
      tokens,
      "getResource",
      resourceId,
      includeData,
      false,
      true,
      false
    );
    let body = includeData ? normalizeBuffer(resource.data?.body) : undefined;

    if (includeData && !body) {
      body = normalizeBuffer(
        await callNoteStore<unknown>(tokens, "getResourceData", resourceId)
      );
    }

    return {
      ok: true,
      status: 200,
      data: mapResourceData(resource, body),
    };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function addAttachmentViaNoteStore(
  tokens: AuthTokens,
  params: CreateAttachmentParams
): Promise<ApiResponse<Attachment>> {
  try {
    const data = normalizeAttachmentData(params.data, params.dataEncoding);
    const mime = inferAttachmentMimeType(params.filename, params.mime);
    const bodyHash = attachmentBodyHash(data);
    const bodyHashHex = attachmentBodyHashHex(data);

    const current = await callNoteStore<RawNote>(
      tokens,
      "getNote",
      params.noteId,
      true,
      false,
      false,
      false
    );
    const resource = new Types.Resource({
      noteGuid: params.noteId,
      mime,
      active: true,
      data: new Types.Data({
        bodyHash,
        size: data.length,
        body: data,
      }),
      attributes: new Types.ResourceAttributes({
        fileName: params.filename,
        attachment: true,
        clientWillIndex: true,
      }),
    });

    const updatedNote: RawNote = {
      ...current,
      guid: params.noteId,
      content: appendAttachmentToEnml(current.content, mime, bodyHashHex),
      resources: [...(current.resources || []), resource],
    };

    await callNoteStore<RawNote>(tokens, "updateNote", updatedNote);
    const refreshed = await callNoteStore<RawNote>(
      tokens,
      "getNote",
      params.noteId,
      false,
      false,
      false,
      false
    );
    const created =
      (refreshed.resources || []).find((candidate) => {
        const candidateHash = normalizeBuffer(candidate.data?.bodyHash)?.toString("hex");
        return candidateHash === bodyHashHex;
      }) || resource;

    return {
      ok: true,
      status: 200,
      data: mapResource(created),
    };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function updateTagViaNoteStore(
  tokens: AuthTokens,
  tagId: string,
  params: { name?: string; parentId?: string }
): Promise<ApiResponse<Tag>> {
  try {
    const existingTags = await callNoteStore<RawTag[]>(tokens, "listTags");
    const current = (existingTags || []).find((tag) => tag.guid === tagId);
    if (!current) {
      return { ok: false, status: 404, error: `Tag not found: ${tagId}` };
    }

    const updatedTag: RawTag = {
      ...current,
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.parentId !== undefined ? { parentGuid: params.parentId } : {}),
    };

    await callNoteStore(tokens, "updateTag", updatedTag);
    const refreshedTags = await callNoteStore<RawTag[]>(tokens, "listTags");
    const refreshed = (refreshedTags || []).find((tag) => tag.guid === tagId) || updatedTag;
    return { ok: true, status: 200, data: mapTag(refreshed) };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function updateNoteViaNoteStore(
  tokens: AuthTokens,
  params: UpdateNoteParams
): Promise<ApiResponse<Note>> {
  try {
    const includeContent = updateRequiresNoteContent(params);
    const current = await callNoteStore<RawNote>(
      tokens,
      "getNote",
      params.id,
      includeContent,
      false,
      false,
      false
    );

    const updatedNote: RawNote = {
      ...current,
      guid: params.id,
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.content !== undefined ? { content: params.content } : {}),
      ...(params.notebookId !== undefined ? { notebookGuid: params.notebookId } : {}),
      ...(params.tagIds !== undefined ? { tagGuids: params.tagIds } : {}),
      ...(params.attributes !== undefined ? { attributes: params.attributes } : {}),
    };

    await callNoteStore(tokens, "updateNote", updatedNote);
    const refreshed = await callNoteStore<RawNote>(
      tokens,
      "getNote",
      params.id,
      includeContent,
      false,
      false,
      false
    );
    return { ok: true, status: 200, data: mapNote(refreshed) };
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function deleteNoteViaNoteStore(
  tokens: AuthTokens,
  noteId: string
): Promise<ApiResponse<void>> {
  try {
    await callNoteStore(tokens, "deleteNote", noteId);
    return { ok: true, status: 200, data: undefined };
  } catch (error) {
    return errorResponse(error, 500);
  }
}
