import assert from "node:assert/strict";
import test from "node:test";

import { formatNoteStoreError, updateRequiresNoteContent } from "../src/notestore.js";

test("metadata-only note updates do not require fetching note content", () => {
  assert.equal(updateRequiresNoteContent({ id: "note-1", title: "Updated title" }), false);
  assert.equal(updateRequiresNoteContent({ id: "note-1", notebookId: "notebook-1" }), false);
  assert.equal(updateRequiresNoteContent({ id: "note-1", tagIds: ["tag-1"] }), false);
});

test("content note updates still fetch content", () => {
  assert.equal(updateRequiresNoteContent({ id: "note-1", content: "" }), true);
  assert.equal(updateRequiresNoteContent({ id: "note-1", content: "<en-note>Body</en-note>" }), true);
});

test("formats EDAM NoteStore errors with code and parameter details", () => {
  assert.equal(
    formatNoteStoreError({
      name: "EDAMUserException",
      message: "EDAMUserException",
      errorCode: 2,
      parameter: "filter",
    }),
    "EDAMUserException: BAD_DATA_FORMAT (2); parameter=filter"
  );
});
