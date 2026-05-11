// ============================================================
// Evernote API Gateway Client
// REST client for https://api.evernote.com/v1/*
// ============================================================

import type {
  AuthTokens,
  EvernoteHeaders,
  ApiResponse,
  Attachment,
  AttachmentData,
  Note,
  CreateNoteParams,
  UpdateNoteParams,
  Notebook,
  CreateNotebookParams,
  Tag,
  CreateTagParams,
  SearchParams,
  SearchResult,
  Shortcut,
  User,
  UsageInfo,
  AISummarizeParams,
  AIRephraseParams,
  CreateAttachmentParams,
  SyncState,
  NoteOcrContents,
  NoteResourceOcr,
  OcrRecognition,
  ResourceOcrContents,
} from "./types.js";
import { refreshTokens as refreshAuthTokens, saveTokens as saveAuthTokens } from "./auth.js";
import { selectGetNoteBackend } from "./evernote-version.js";
import {
  addAttachmentViaNoteStore,
  createNotebookViaNoteStore,
  createTagViaNoteStore,
  deleteNoteViaNoteStore,
  deleteNotebookViaNoteStore,
  getAttachmentViaNoteStore,
  getNoteViaNoteStore,
  getNotebookViaNoteStore,
  getResourceMetadataViaNoteStore,
  listAttachmentsViaNoteStore,
  listNotesViaNoteStore,
  listNotebooksViaNoteStore,
  listTagsViaNoteStore,
  updateNoteViaNoteStore,
  updateTagViaNoteStore,
} from "./notestore.js";

// --- Constants ---

const API_GATEWAY = "https://api.evernote.com";
const QUERY_SERVICE = "https://api.evernote.com/query";
const MONOLITH = "https://www.evernote.com";
const FEATURE_VERSION = "4";
const CONDUIT_VERSION = "2.111.0";

const NOTE_RECOGNITIONS_QUERY = `
query NoteRecognitions($id: String!) {
  note(note: $id) {
    id
    resources {
      id
      recognition {
        content
        size
        hash
      }
    }
  }
}`;

const NOTE_RECOGNITIONS_AND_SEARCH_QUERY = `
query NoteRecognitionsAndSearch($id: String!) {
  note(note: $id) {
    id
    resources {
      id
      data {
        hash
      }
      recognition {
        content
        size
        hash
      }
      searchText
    }
  }
}`;

const RESOURCE_RECOGNITION_AND_SEARCH_QUERY = `
query ResourceRecognitions($id: String!) {
  resource(resource: $id) {
    recognition {
      content
    }
    searchText
  }
}`;

type AuthRefreshFn = (tokens: AuthTokens) => Promise<AuthTokens>;
type AuthSaveFn = (tokens: AuthTokens, path?: string) => Promise<void>;

type ClientAuthOptions = {
  refreshTokens?: AuthRefreshFn;
  saveTokens?: AuthSaveFn;
};

export function isNoteStoreAuthExpiredResponse(response: ApiResponse<unknown>): boolean {
  return (
    !response.ok &&
    typeof response.error === "string" &&
    response.error.includes("EDAMUserException: AUTH_EXPIRED (9)") &&
    response.error.includes("parameter=authenticationToken")
  );
}

type GraphQLError = {
  message?: string;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: GraphQLError[];
};

type QuasarEntityRef = {
  type: "Note";
  id: string;
};

type QuasarEntityMetadata = {
  entityID: string;
  ownerID: number;
  shardID: number;
  generatedID: null;
  parentRef: QuasarEntityRef | null;
};

type QuasarRecognition = {
  content?: string | null;
  size?: number | null;
  hash?: string | null;
};

type QuasarResourceOcr = {
  id?: string | null;
  data?: {
    hash?: string | null;
  } | null;
  recognition?: QuasarRecognition | null;
  searchText?: string | null;
};

type QuasarNoteOcrData = {
  note?: {
    id?: string | null;
    resources?: QuasarResourceOcr[] | null;
  } | null;
};

type QuasarResourceOcrData = {
  resource?: {
    recognition?: QuasarRecognition | null;
    searchText?: string | null;
  } | null;
};

function normalizeRecognition(
  recognition: QuasarRecognition | null | undefined
): OcrRecognition | undefined {
  if (!recognition) return undefined;

  const normalized: OcrRecognition = {};
  if (recognition.content != null) normalized.content = recognition.content;
  if (recognition.size != null) normalized.size = recognition.size;
  if (recognition.hash != null) normalized.hash = recognition.hash;

  return Object.keys(normalized).length ? normalized : undefined;
}

function mapQuasarResourceOcr(resource: QuasarResourceOcr): NoteResourceOcr {
  const mapped: NoteResourceOcr = { id: resource.id || "" };
  const recognition = normalizeRecognition(resource.recognition);

  if (resource.data?.hash) mapped.dataHash = resource.data.hash;
  if (recognition) mapped.recognition = recognition;
  if (resource.searchText) mapped.searchText = resource.searchText;

  return mapped;
}

// --- Client ---

export class EvernoteClient {
  private tokens: AuthTokens;
  private tokenPath?: string;
  private refreshAuthTokens: AuthRefreshFn;
  private saveAuthTokens: AuthSaveFn;

  constructor(tokens: AuthTokens, tokenPath?: string, authOptions: ClientAuthOptions = {}) {
    this.tokens = tokens;
    this.tokenPath = tokenPath;
    this.refreshAuthTokens = authOptions.refreshTokens || refreshAuthTokens;
    this.saveAuthTokens = authOptions.saveTokens || saveAuthTokens;
  }

  // ─── Internal HTTP helpers ───────────────────────────────

  private buildHeaders(json = true): EvernoteHeaders {
    return {
      Authorization: `Bearer ${this.tokens.jwt}`,
      "x-mono-authn-token": this.tokens.legacyToken,
      "x-feature-version": FEATURE_VERSION,
      "x-conduit-version": CONDUIT_VERSION,
      "Content-Type": json ? "application/json" : "application/octet-stream",
    };
  }

  private async ensureValidToken(): Promise<void> {
    // Refresh if token expires within 60 seconds
    if (this.tokens.expiresAt < Date.now() + 60_000 && this.tokens.refreshToken) {
      try {
        await this.refreshAndSaveTokens();
      } catch {
        // If refresh fails, continue with existing token
        // The server will return 401 and the caller can re-authenticate
      }
    }
  }

  private async refreshAndSaveTokens(): Promise<void> {
    this.tokens = await this.refreshAuthTokens(this.tokens);
    if (this.tokenPath) {
      await this.saveAuthTokens(this.tokens, this.tokenPath);
    }
  }

  private async noteStoreRequest<T>(
    operation: () => Promise<ApiResponse<T>>
  ): Promise<ApiResponse<T>> {
    await this.ensureValidToken();

    const result = await operation();
    if (!isNoteStoreAuthExpiredResponse(result) || !this.tokens.refreshToken) {
      return result;
    }

    try {
      await this.refreshAndSaveTokens();
    } catch {
      return result;
    }

    return operation();
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
    base: string = API_GATEWAY
  ): Promise<ApiResponse<T>> {
    await this.ensureValidToken();

    let url = `${base}${path}`;

    // Append query parameters
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.set(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const options: RequestInit = {
      method,
      headers: this.buildHeaders(),
    };

    if (body !== undefined && method !== "GET") {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          ok: false,
          status: response.status,
          error: `${response.status} ${response.statusText}: ${errorText}`,
        };
      }

      // Some endpoints return no content
      const contentType = response.headers.get("content-type") || "";
      if (
        response.status === 204 ||
        !contentType.includes("application/json")
      ) {
        return { ok: true, status: response.status, data: undefined as T };
      }

      const data = (await response.json()) as T;
      return { ok: true, status: response.status, data };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async queryQuasar<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    entityMetadata: Record<string, QuasarEntityMetadata[]> = {}
  ): Promise<ApiResponse<T>> {
    await this.ensureValidToken();

    try {
      const response = await fetch(`${QUERY_SERVICE}/v1/graphql`, {
        method: "POST",
        headers: {
          ...this.buildHeaders(),
          Metadata: JSON.stringify({
            id: crypto.randomUUID(),
            entityMetadata,
          }),
        },
        body: JSON.stringify({
          operationName: null,
          query,
          variables,
        }),
      });

      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? ((await response.json()) as GraphQLResponse<T>)
        : undefined;

      if (!response.ok) {
        const errorText = data
          ? JSON.stringify(data)
          : await response.text();
        return {
          ok: false,
          status: response.status,
          error: `${response.status} ${response.statusText}: ${errorText}`,
        };
      }

      if (data?.errors?.length) {
        return {
          ok: false,
          status: response.status,
          error: data.errors
            .map((error) => error.message || "GraphQL error")
            .join("; "),
        };
      }

      return { ok: true, status: response.status, data: data?.data as T };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildEntityMetadata(
    entityId: string,
    parentRef: QuasarEntityRef | null
  ): QuasarEntityMetadata {
    return {
      entityID: entityId,
      ownerID: Number(this.tokens.userId),
      shardID: Number(this.tokens.shard.replace(/^s/, "")),
      generatedID: null,
      parentRef,
    };
  }

  // ─── User ────────────────────────────────────────────────

  /** Get the currently authenticated user's profile */
  async getUser(): Promise<ApiResponse<User>> {
    return this.request<User>("GET", "/v1/users/me");
  }

  /** Get usage statistics (upload limits, note count, etc.) */
  async getUsage(): Promise<ApiResponse<UsageInfo>> {
    return this.request<UsageInfo>("GET", "/v1/users/me/usage");
  }

  /** List all devices connected to this account */
  async getDevices(): Promise<ApiResponse<unknown>> {
    return this.request("GET", "/v1/users/me/devices");
  }

  // ─── List endpoints ──────────────────────────────────────

  /** List all notebooks */
  async listNotebooks(): Promise<ApiResponse<Notebook[]>> {
    return this.noteStoreRequest(() => listNotebooksViaNoteStore(this.tokens));
  }

  /** List all tags */
  async listTags(): Promise<ApiResponse<Tag[]>> {
    return this.noteStoreRequest(() => listTagsViaNoteStore(this.tokens));
  }

  /** List recently updated notes with metadata. */
  async listNotes(maxResults: number = 50): Promise<ApiResponse<SearchResult[]>> {
    return this.noteStoreRequest(() => listNotesViaNoteStore(this.tokens, maxResults));
  }

  // ─── Get by ID ──────────────────────────────────────────

  /** Get a single note by ID. Full content is included by default. */
  async getNote(
    noteId: string,
    options: { includeContent?: boolean } = {}
  ): Promise<ApiResponse<Note>> {
    if (selectGetNoteBackend() === "notestore") {
      return this.noteStoreRequest(() =>
        getNoteViaNoteStore(this.tokens, noteId, options.includeContent !== false)
      );
    }

    return this.request<Note>(
      "GET",
      `/v1/notes/${encodeURIComponent(noteId)}`
    );
  }

  /** Get a single notebook by ID */
  async getNotebook(notebookId: string): Promise<ApiResponse<Notebook>> {
    return this.noteStoreRequest(() => getNotebookViaNoteStore(this.tokens, notebookId));
  }

  // ─── Notes ───────────────────────────────────────────────

  /**
   * Create a new note.
   *
   * Content must be valid ENML wrapped in <en-note> tags:
   * ```
   * <?xml version="1.0" encoding="UTF-8"?>
   * <!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
   * <en-note><p>Hello World</p></en-note>
   * ```
   */
  async createNote(params: CreateNoteParams): Promise<ApiResponse<Note>> {
    const seed = crypto.randomUUID();
    const now = Date.now();

    return this.request<Note>("POST", "/v1/notes", {
      seed,
      created: new Date(now).toISOString(),
      updated: new Date(now).toISOString(),
      title: params.title,
      enmlContent: params.content,
      tagIds: params.tagIds || [],
      fallbackToDefaultNotebook: !params.notebookId,
      parent: params.notebookId
        ? { id: params.notebookId, type: "NOTEBOOK" }
        : undefined,
      attributes: params.attributes || {},
    });
  }

  /**
   * Update an existing note.
   * Uses the Thrift monolith endpoint since the API Gateway
   * doesn't expose a direct update — updates go through Conduit/NSync.
   */
  async updateNote(params: UpdateNoteParams): Promise<ApiResponse<Note>> {
    return this.noteStoreRequest(() => updateNoteViaNoteStore(this.tokens, params));
  }

  /**
   * Delete a note (moves to trash).
   * Uses the NSync command service.
   */
  async deleteNote(noteId: string): Promise<ApiResponse<void>> {
    return this.noteStoreRequest(() => deleteNoteViaNoteStore(this.tokens, noteId));
  }

  /** Request access to a shared note */
  async requestNoteAccess(noteId: string): Promise<ApiResponse<void>> {
    return this.request<void>(
      "POST",
      `/v1/notes/${encodeURIComponent(noteId)}/request-access`
    );
  }

  /** Schedule a reminder for a note */
  async scheduleReminder(
    noteId: string,
    reminderTime: number
  ): Promise<ApiResponse<void>> {
    return this.request<void>(
      "POST",
      `/v1/notes/${encodeURIComponent(noteId)}/schedule-satellite-reminder`,
      { reminderTime }
    );
  }

  // ─── Notebooks ───────────────────────────────────────────

  /**
   * Create a new notebook.
   * Uses the NSync command service.
   */
  async createNotebook(
    params: CreateNotebookParams
  ): Promise<ApiResponse<Notebook>> {
    return this.noteStoreRequest(() => createNotebookViaNoteStore(this.tokens, params));
  }

  /** Delete a notebook by ID */
  async deleteNotebook(notebookId: string): Promise<ApiResponse<void>> {
    return this.noteStoreRequest(() => deleteNotebookViaNoteStore(this.tokens, notebookId));
  }

  // ─── Tags ────────────────────────────────────────────────

  /**
   * Create a new tag.
   * Uses the NSync command service.
   */
  async createTag(params: CreateTagParams): Promise<ApiResponse<Tag>> {
    return this.noteStoreRequest(() => createTagViaNoteStore(this.tokens, params));
  }

  /** Update a tag's name or parent */
  async updateTag(
    tagId: string,
    params: Partial<CreateTagParams>
  ): Promise<ApiResponse<Tag>> {
    return this.noteStoreRequest(() => updateTagViaNoteStore(this.tokens, tagId, params));
  }

  // ─── Search ──────────────────────────────────────────────

  /**
   * Semantic (AI-powered) search across your notes.
   * Uses Evernote's built-in semantic search engine.
   * Returns hits with noteGuid and relevance score.
   */
  async searchSemantic(params: SearchParams): Promise<ApiResponse<SearchResult[]>> {
    const tz = params.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return this.request<SearchResult[]>("GET", "/v1/search/semantic", undefined, {
      naturalLanguageQuery: params.query,
      maxResults: params.maxResults ?? 20,
      clientTimeZone: tz,
      keywordSearchFallback: params.keywordFallback ?? true,
    });
  }

  /**
   * Get AI-generated answer based on your notes.
   * The AI will find relevant notes and synthesize an answer.
   * Returns { answer: string, sourceNoteGuids: string[] }
   */
  async semanticAnswer(query: string): Promise<ApiResponse<{ answer: string; sourceNoteGuids: string[] }>> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return this.request("GET", "/v1/search/generate-semantic-answer", undefined, {
      naturalLanguageQuery: query,
      clientTimeZone: tz,
    });
  }

  /**
   * Get related notes or AI-generated answer.
   * Returns intent ("related_notes" | "answer") plus results.
   */
  async relatedNotesOrAnswer(query: string): Promise<ApiResponse<unknown>> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return this.request("GET", "/v1/search/related-notes-or-answer", undefined, {
      naturalLanguageQuery: query,
      clientTimeZone: tz,
    });
  }

  // ─── Shortcuts ───────────────────────────────────────────

  /** Create a shortcut to a note, notebook, tag, or search */
  async createShortcut(shortcut: Omit<Shortcut, "id">): Promise<ApiResponse<Shortcut>> {
    return this.request<Shortcut>("POST", "/v1/shortcuts", shortcut);
  }

  /** Update a shortcut */
  async updateShortcut(
    id: string,
    update: Partial<Shortcut>
  ): Promise<ApiResponse<Shortcut>> {
    return this.request<Shortcut>(
      "PATCH",
      `/v1/shortcuts/${encodeURIComponent(id)}`,
      update
    );
  }

  /** Delete a shortcut */
  async deleteShortcut(id: string): Promise<ApiResponse<void>> {
    return this.request<void>(
      "DELETE",
      `/v1/shortcuts/${encodeURIComponent(id)}`
    );
  }

  // ─── Attachments ─────────────────────────────────────────

  /** Get a pre-signed upload URL for an attachment */
  async createUploadUrl(params: {
    filename: string;
    mime: string;
    size: number;
  }): Promise<ApiResponse<{ uploadUrl: string; fileToken: string }>> {
    return this.request("POST", "/v1/attachments/create-upload-url", params);
  }

  /** List metadata for resources/attachments attached to a note. */
  async listAttachments(noteId: string): Promise<ApiResponse<Attachment[]>> {
    return this.noteStoreRequest(() => listAttachmentsViaNoteStore(this.tokens, noteId));
  }

  /**
   * Add a binary attachment to an existing note.
   * Accepts Buffer/Uint8Array data, or a base64 string for REST/MCP callers.
   */
  async addAttachment(
    params: CreateAttachmentParams
  ): Promise<ApiResponse<Attachment>> {
    return this.noteStoreRequest(() => addAttachmentViaNoteStore(this.tokens, params));
  }

  /**
   * Retrieve an attachment's metadata and, by default, base64-encoded binary body.
   */
  async getAttachment(
    resourceId: string,
    options: { includeData?: boolean } = {}
  ): Promise<ApiResponse<AttachmentData>> {
    return this.noteStoreRequest(() => getAttachmentViaNoteStore(this.tokens, resourceId, options));
  }

  // ─── Workspaces (Spaces) ─────────────────────────────────

  /** Delete a workspace/space */
  async deleteWorkspace(workspaceId: string): Promise<ApiResponse<void>> {
    return this.request<void>(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}`
    );
  }

  /** List business directory workspaces */
  async listBusinessWorkspaces(): Promise<ApiResponse<unknown>> {
    return this.request("GET", "/v1/workspaces/business-directory");
  }

  // ─── AI Features ─────────────────────────────────────────

  /** Summarize text using Evernote AI */
  async aiSummarize(params: AISummarizeParams): Promise<ApiResponse<{ summary: string }>> {
    return this.request("POST", "/v1/ai/summarize", params);
  }

  /** Rephrase text using Evernote AI */
  async aiRephrase(params: AIRephraseParams): Promise<ApiResponse<{ result: string }>> {
    return this.request("POST", "/v1/ai/rephrase", params);
  }

  /**
   * Get AI tag suggestions for a note.
   * Returns { suggestedExistingTags: string[], suggestedNewTags: string[] }
   */
  async aiSuggestTags(noteGuid: string): Promise<ApiResponse<{ suggestedExistingTags: string[]; suggestedNewTags: string[] }>> {
    return this.request("POST", "/v1/ai/suggest-tags", { noteGuid });
  }

  /**
   * Get AI title suggestion for a note.
   * Returns { suggestedTitle: string }
   */
  async aiSuggestTitle(noteGuid: string): Promise<ApiResponse<{ suggestedTitle: string }>> {
    return this.request("POST", "/v1/ai/suggest-title", { noteGuid });
  }

  /** AI copilot — send a prompt */
  async aiCopilot(prompt: string, context?: string): Promise<ApiResponse<unknown>> {
    return this.request("POST", "/v1/ai/copilot/send", { prompt, context });
  }

  /** Detect if text is AI-generated */
  async aiDetectText(text: string): Promise<ApiResponse<{ isAi: boolean; confidence: number }>> {
    return this.request("POST", "/v1/ai/detect-ai-text", { text });
  }

  // ─── Rich Links & Productivity ───────────────────────────

  /**
   * Generate a rich link preview for a URL.
   * Returns { url, pageTitle, faviconUrl, logoUrl, imageUrl, description }
   */
  async richLink(url: string): Promise<ApiResponse<unknown>> {
    return this.request("GET", "/v1/links/rich-link", undefined, { url });
  }

  /** OCR a business card image */
  async ocrBusinessCard(imageData: string): Promise<ApiResponse<unknown>> {
    return this.request("POST", "/v1/ocr/business-card", { image: imageData });
  }

  /**
   * Get OCR/recognition content for every resource attached to a note.
   * Uses the Quasar Query GraphQL service used by newer Evernote clients.
   */
  async getNoteOcrContents(
    noteId: string,
    options: { includeSearchText?: boolean } = {}
  ): Promise<ApiResponse<NoteOcrContents>> {
    const includeSearchText = options.includeSearchText ?? true;
    const response = await this.queryQuasar<QuasarNoteOcrData>(
      includeSearchText ? "NoteRecognitionsAndSearch" : "NoteRecognitions",
      includeSearchText
        ? NOTE_RECOGNITIONS_AND_SEARCH_QUERY
        : NOTE_RECOGNITIONS_QUERY,
      { id: noteId },
      {
        Note: [
          this.buildEntityMetadata(noteId, {
            type: "Note",
            id: noteId,
          }),
        ],
      }
    );

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: response.error,
      };
    }
    if (!response.data?.note) {
      return {
        ok: false,
        status: 404,
        error: `Note OCR contents not found: ${noteId}`,
      };
    }

    return {
      ok: true,
      status: response.status,
      data: {
        noteId: response.data.note.id || noteId,
        resources: (response.data.note.resources || []).map(mapQuasarResourceOcr),
      },
    };
  }

  /**
   * Get OCR/recognition content for a single resource/attachment.
   * Uses the Quasar Query GraphQL service used by newer Evernote clients.
   */
  async getResourceOcrContents(
    resourceId: string,
    options: { noteId?: string } = {}
  ): Promise<ApiResponse<ResourceOcrContents>> {
    let noteId = options.noteId;
    if (!noteId) {
      const resource = await this.noteStoreRequest(() =>
        getResourceMetadataViaNoteStore(this.tokens, resourceId)
      );
      if (!resource.ok) {
        return {
          ok: false,
          status: resource.status,
          error: resource.error,
        };
      }
      noteId = resource.data?.noteId;
    }

    if (!noteId) {
      return {
        ok: false,
        status: 400,
        error: `Parent note ID is required for resource OCR: ${resourceId}`,
      };
    }

    const response = await this.queryQuasar<QuasarResourceOcrData>(
      "ResourceRecognitions",
      RESOURCE_RECOGNITION_AND_SEARCH_QUERY,
      { id: resourceId },
      {
        Resource: [
          this.buildEntityMetadata(resourceId, {
            type: "Note",
            id: noteId,
          }),
        ],
      }
    );

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: response.error,
      };
    }
    if (!response.data?.resource) {
      return {
        ok: false,
        status: 404,
        error: `Resource OCR contents not found: ${resourceId}`,
      };
    }

    const data: ResourceOcrContents = {
      resourceId,
      noteId,
    };
    const recognition = normalizeRecognition(response.data.resource.recognition);
    if (recognition) data.recognition = recognition;
    if (response.data.resource.searchText) {
      data.searchText = response.data.resource.searchText;
    }

    return {
      ok: true,
      status: response.status,
      data,
    };
  }

  // ─── Notes Import/Export ─────────────────────────────────

  /** Prepare a notes import job */
  async prepareImport(): Promise<ApiResponse<unknown>> {
    return this.request("POST", "/v1/notes/prepare-import");
  }

  /** Trigger a notes import */
  async triggerImport(importData: unknown): Promise<ApiResponse<unknown>> {
    return this.request("POST", "/v1/notes/import", importData);
  }

  /** Export notes by IDs or by notebook */
  async exportNotes(noteIds?: string[], notebookGuids?: string[]): Promise<ApiResponse<unknown>> {
    return this.request("POST", "/v1/notes/export", {
      ...(noteIds && { noteGuids: noteIds }),
      ...(notebookGuids && { notebookGuids }),
    });
  }

  // ─── Billing / Subscription (read-only) ──────────────────

  /** Get billing information */
  async getBilling(): Promise<ApiResponse<unknown>> {
    return this.request("GET", "/v1/users/me/billing/individual");
  }

  /** Get payment history */
  async getPayments(): Promise<ApiResponse<unknown>> {
    return this.request("GET", "/v1/users/me/billing/individual/payments");
  }

  /** Get pricing for a subscription level */
  async getPricing(level: string): Promise<ApiResponse<unknown>> {
    return this.request(
      "GET",
      `/v1/users/pricing/${encodeURIComponent(level)}`
    );
  }

  // ─── Conduit Sync Database ───────────────────────────────

  /**
   * Download the prebuilt sync database.
   * This is a SQLite binary blob used by the Conduit worker
   * for offline-first sync. Advanced use only.
   */
  async downloadSyncDatabase(version: string): Promise<ApiResponse<ArrayBuffer>> {
    await this.ensureValidToken();

    const url = `${API_GATEWAY}/v1/conduit/database?version=${encodeURIComponent(version)}`;
    const response = await fetch(url, {
      headers: this.buildHeaders(false),
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Failed to download sync DB: ${response.status}`,
      };
    }

    const data = await response.arrayBuffer();
    return { ok: true, status: response.status, data };
  }

  // ─── Monolith (Thrift) Proxy ─────────────────────────────
  // For operations that only exist on the legacy Thrift API.
  // These endpoints require the legacy auth token.

  /** Get note thumbnail URL */
  getThumbnailUrl(noteId: string): string {
    return `https://public.www.evernote.com/resources/note/thumbnail/${this.tokens.shard}/${noteId}`;
  }

  /** Get user photo URL */
  getUserPhotoUrl(size: number = 112): string {
    return `${MONOLITH}/shard/${this.tokens.shard}/user/${this.tokens.userId}/photo?t=0&size=${size}`;
  }

  /** Get shared note URL */
  getSharedNoteUrl(noteId: string, ownerId: string): string {
    return `${MONOLITH}/shard/${this.tokens.shard}/nl/${ownerId}/${noteId}`;
  }

  // ─── Raw request (for undocumented endpoints) ────────────

  /**
   * Make a raw request to any API Gateway endpoint.
   * Useful for calling endpoints not yet wrapped in this client.
   */
  async raw<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<ApiResponse<T>> {
    return this.request<T>(method, path, body, query);
  }

  /**
   * Make a raw request to the Monolith (www.evernote.com).
   * For legacy Thrift endpoints — you'll need to handle
   * binary Thrift encoding yourself.
   */
  async rawMonolith<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<ApiResponse<T>> {
    return this.request<T>(method, path, body, query, MONOLITH);
  }

  // ─── Token accessors ─────────────────────────────────────

  /** Get current auth tokens (for manual use or debugging) */
  getTokens(): AuthTokens {
    return { ...this.tokens };
  }

  /** Get the user's shard ID */
  getShard(): string {
    return this.tokens.shard;
  }

  /** Get the user's ID */
  getUserId(): string {
    return this.tokens.userId;
  }
}
