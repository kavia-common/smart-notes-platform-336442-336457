"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { NotesApi, type Note, type NoteCreate } from "@/lib/api";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";

type SaveState = "idle" | "saving" | "saved" | "error";

function formatListDate(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function deriveTitle(note: Pick<Note, "title" | "content">) {
  const t = note.title?.trim();
  if (t) return t;
  const c = note.content?.trim();
  if (!c) return "Untitled";
  return c.split("\n")[0].slice(0, 60) || "Untitled";
}

function normalizeTags(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // De-dupe case-insensitively but preserve first occurrence
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export default function Home() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editor state (draft)
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftTagsInput, setDraftTagsInput] = useState("");

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string>("");

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId]
  );

  const lastLoadedNoteId = useRef<string | null>(null);
  const lastSavedSnapshot = useRef<string>("");

  async function refreshList(q?: string) {
    setLoadingList(true);
    setLoadError(null);
    try {
      const list = await NotesApi.listNotes(q);
      // Sort newest updated first if present
      const sorted = [...list].sort((a, b) => {
        const au = a.updated_at ?? a.created_at ?? "";
        const bu = b.updated_at ?? b.created_at ?? "";
        return bu.localeCompare(au);
      });
      setNotes(sorted);

      // Keep selection if possible, otherwise select first
      setSelectedId((prev) => {
        if (prev && sorted.some((n) => n.id === prev)) return prev;
        return sorted.length ? sorted[0].id : null;
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load notes");
    } finally {
      setLoadingList(false);
    }
  }

  // Initial load
  useEffect(() => {
    void refreshList();
  }, []);

  // Load selected note into editor draft when selection changes
  useEffect(() => {
    if (!selectedNote) {
      lastLoadedNoteId.current = null;
      setDraftTitle("");
      setDraftContent("");
      setDraftTagsInput("");
      setSaveState("idle");
      setSaveMessage("");
      lastSavedSnapshot.current = "";
      return;
    }
    if (lastLoadedNoteId.current === selectedNote.id) return;

    lastLoadedNoteId.current = selectedNote.id;
    setDraftTitle(selectedNote.title ?? "");
    setDraftContent(selectedNote.content ?? "");
    setDraftTagsInput((selectedNote.tags ?? []).join(", "));
    setSaveState("idle");
    setSaveMessage("");
    lastSavedSnapshot.current = JSON.stringify({
      title: selectedNote.title ?? "",
      content: selectedNote.content ?? "",
      tags: (selectedNote.tags ?? []).slice().sort(),
    });
  }, [selectedNote]);

  const debouncedSearch = useDebouncedCallback((q: string) => {
    void refreshList(q);
  }, 250);

  function onSearchChange(v: string) {
    setSearch(v);
    debouncedSearch(v);
  }

  async function createNewNote() {
    const payload: NoteCreate = {
      title: "New note",
      content: "",
      tags: [],
    };

    try {
      setLoadError(null);
      const created = await NotesApi.createNote(payload);
      // Add locally and select
      setNotes((prev) => [created, ...prev]);
      setSelectedId(created.id);
      setSearch("");
      setSaveState("idle");
      setSaveMessage("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to create note");
    }
  }

  async function deleteSelected() {
    if (!selectedNote) return;
    const ok = window.confirm(
      `Delete "${deriveTitle(selectedNote)}"? This cannot be undone.`
    );
    if (!ok) return;

    try {
      setLoadError(null);
      await NotesApi.deleteNote(selectedNote.id);
      setNotes((prev) => prev.filter((n) => n.id !== selectedNote.id));
      setSelectedId((prev) => {
        if (prev !== selectedNote.id) return prev;
        const remaining = notes.filter((n) => n.id !== selectedNote.id);
        return remaining.length ? remaining[0].id : null;
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to delete note");
    }
  }

  const debouncedAutosave = useDebouncedCallback(async () => {
    if (!selectedNote) return;

    const tags = normalizeTags(draftTagsInput);
    const snapshot = JSON.stringify({
      title: draftTitle ?? "",
      content: draftContent ?? "",
      tags: tags.slice().sort(),
    });

    // Avoid saving if unchanged
    if (snapshot === lastSavedSnapshot.current) return;

    setSaveState("saving");
    setSaveMessage("Saving…");
    try {
      const updated = await NotesApi.updateNote(selectedNote.id, {
        title: draftTitle,
        content: draftContent,
        tags,
      });

      setNotes((prev) =>
        prev.map((n) => (n.id === updated.id ? { ...n, ...updated } : n))
      );
      lastSavedSnapshot.current = snapshot;
      setSaveState("saved");
      setSaveMessage("Saved");
      window.setTimeout(() => {
        // Keep "Saved" from getting stuck forever
        setSaveState((s) => (s === "saved" ? "idle" : s));
        setSaveMessage((m) => (m === "Saved" ? "" : m));
      }, 1200);
    } catch (e) {
      setSaveState("error");
      setSaveMessage("Save failed");
      setLoadError(e instanceof Error ? e.message : "Failed to save note");
    }
  }, 700);

  function updateDraftAndAutosave(update: () => void) {
    update();
    // Autosave only for an existing note
    if (selectedNote) debouncedAutosave();
  }

  const tagPills = useMemo(() => normalizeTags(draftTagsInput), [draftTagsInput]);

  function removeTag(tag: string) {
    const next = tagPills.filter((t) => t.toLowerCase() !== tag.toLowerCase());
    updateDraftAndAutosave(() => setDraftTagsInput(next.join(", ")));
  }

  const isMobile = false; // layout handles responsiveness via CSS; kept for future enhancements

  return (
    <main className="container-app">
      {/* Sidebar */}
      <aside
        className="surface"
        style={{
          borderRadius: 0,
          borderTop: 0,
          borderLeft: 0,
          borderBottom: 0,
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          minHeight: "100dvh",
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            aria-hidden="true"
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              background:
                "linear-gradient(135deg, rgba(59,130,246,0.15), rgba(6,182,212,0.15))",
              border: "1px solid rgba(59,130,246,0.25)",
              display: "grid",
              placeItems: "center",
              color: "var(--primary)",
              fontWeight: 700,
            }}
          >
            SN
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 650 }}>Smart Notes</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Search, tags, autosave
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => void createNewNote()}>
            New
          </button>
        </header>

        <div style={{ display: "flex", gap: "8px" }}>
          <input
            className="input"
            placeholder="Search notes…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label="Search notes"
          />
        </div>

        {loadError ? (
          <div
            className="surface"
            style={{
              padding: 10,
              borderColor: "rgba(239, 68, 68, 0.35)",
              background: "rgba(239, 68, 68, 0.06)",
              color: "var(--danger)",
              fontSize: 13,
            }}
            role="alert"
          >
            {loadError}
          </div>
        ) : null}

        <div className="hr" />

        <div
          style={{
            flex: 1,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            paddingRight: 4,
          }}
          aria-label="Notes list"
        >
          {loadingList ? (
            <div className="muted" style={{ fontSize: 13 }}>
              Loading…
            </div>
          ) : null}

          {!loadingList && notes.length === 0 ? (
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              No notes yet. Create one with <b>New</b>.
            </div>
          ) : null}

          {notes.map((n) => {
            const active = n.id === selectedId;
            const title = deriveTitle(n);
            const snippet = (n.content ?? "").trim().slice(0, 120);
            const when = formatListDate(n.updated_at ?? n.created_at);

            return (
              <button
                key={n.id}
                onClick={() => setSelectedId(n.id)}
                className="surface"
                style={{
                  textAlign: "left",
                  padding: 12,
                  cursor: "pointer",
                  borderColor: active
                    ? "rgba(59, 130, 246, 0.55)"
                    : "var(--border)",
                  boxShadow: active ? "0 0 0 4px var(--ring)" : "none",
                  background: active
                    ? "linear-gradient(180deg, rgba(59,130,246,0.06), rgba(6,182,212,0.04))"
                    : "var(--surface)",
                }}
                aria-current={active ? "true" : undefined}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div style={{ fontWeight: 650, fontSize: 14 }}>{title}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {when}
                  </div>
                </div>
                <div
                  className="muted"
                  style={{ fontSize: 12, marginTop: 6, lineHeight: 1.4 }}
                >
                  {snippet || "—"}
                </div>
                {(n.tags?.length ?? 0) > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {n.tags.slice(0, 3).map((t) => (
                      <span key={t} className="pill">
                        {t}
                      </span>
                    ))}
                    {n.tags.length > 3 ? (
                      <span className="muted" style={{ fontSize: 12 }}>
                        +{n.tags.length - 3}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>

        <footer className="muted" style={{ fontSize: 12 }}>
          API:{" "}
          <code style={{ fontSize: 12 }}>
            {process.env.NEXT_PUBLIC_NOTES_API_BASE_URL ??
              "http://localhost:3001"}
          </code>
        </footer>
      </aside>

      {/* Main pane */}
      <section
        style={{
          padding: 16,
          minHeight: "100dvh",
        }}
      >
        <div
          className="surface"
          style={{
            height: "calc(100dvh - 32px)",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {!selectedNote ? (
            <div style={{ margin: "auto", textAlign: "center", maxWidth: 520 }}>
              <h1 style={{ fontSize: 26, fontWeight: 750 }}>Smart Notes</h1>
              <p className="muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
                Create and edit notes with tags, search, and autosave.
              </p>
              <div style={{ marginTop: 16 }}>
                <button className="btn btn-primary" onClick={() => void createNewNote()}>
                  Create your first note
                </button>
              </div>
            </div>
          ) : (
            <>
              <header
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div>
                  <div style={{ fontSize: 12 }} className="muted">
                    {saveMessage ? saveMessage : saveState === "saving" ? "Saving…" : ""}
                  </div>
                  <div style={{ fontSize: 12 }} className="muted">
                    {selectedNote.updated_at || selectedNote.created_at
                      ? `Last updated ${formatListDate(
                          selectedNote.updated_at ?? selectedNote.created_at
                        )}`
                      : ""}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-danger" onClick={() => void deleteSelected()}>
                    Delete
                  </button>
                </div>
              </header>

              <div className="hr" />

              <label style={{ display: "grid", gap: 6 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  Title
                </span>
                <input
                  className="input"
                  value={draftTitle}
                  onChange={(e) =>
                    updateDraftAndAutosave(() => setDraftTitle(e.target.value))
                  }
                  placeholder="Untitled"
                />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  Tags (comma separated)
                </span>
                <input
                  className="input"
                  value={draftTagsInput}
                  onChange={(e) =>
                    updateDraftAndAutosave(() => setDraftTagsInput(e.target.value))
                  }
                  placeholder="e.g. work, ideas, personal"
                />
              </label>

              {tagPills.length ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {tagPills.map((t) => (
                    <span key={t} className="pill">
                      {t}
                      <button
                        type="button"
                        onClick={() => removeTag(t)}
                        aria-label={`Remove tag ${t}`}
                        title="Remove tag"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <label style={{ display: "grid", gap: 6, flex: 1 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  Note
                </span>
                <textarea
                  className="textarea"
                  value={draftContent}
                  onChange={(e) =>
                    updateDraftAndAutosave(() => setDraftContent(e.target.value))
                  }
                  placeholder="Write your note here…"
                  style={{ flex: 1 }}
                />
              </label>

              <div
                className="muted"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                }}
              >
                <span>
                  Autosave{" "}
                  {saveState === "saving"
                    ? "in progress…"
                    : saveState === "error"
                      ? "failed (check backend)"
                      : "enabled"}
                </span>
                <span>
                  {draftContent.length} chars • {tagPills.length} tags
                </span>
              </div>
            </>
          )}
        </div>

        {/* Mobile hint */}
        {isMobile ? null : null}
      </section>
    </main>
  );
}
