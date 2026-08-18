import { Trash2, User, Users, X } from "lucide-react";
import { useRef, useState } from "react";
import { ModalShell } from "@/components/ModalShell";
import {
  applyMemoryWrite,
  type BlobMemory,
  MEMORY_LIMIT,
  MEMORY_TEXT_LIMIT,
  type MemoryWrite,
} from "@/lib/memory";
import { prefersReducedMotion } from "@/lib/motion";
import { useFlipRows } from "@/lib/useFlipRows";

interface MemoriesModalProps {
  blobName: string;
  /** This Blob's own facts, in prompt order. */
  memories: BlobMemory[];
  /** Facts every Blob can read (the `user` store slice). */
  userMemories: BlobMemory[];
  onChange: (next: { blob?: BlobMemory[]; user?: BlobMemory[] }) => void;
  onClose: () => void;
}

/**
 * What the Blob remembers, in both scopes.
 *
 * A table in a dialog rather than a list in the panel: forty facts pushed
 * every other section out of a 322px column, and a fact is a sentence, not a
 * label — at that width each one wrapped to three lines and the scope and
 * delete controls sat wherever the wrap left them.
 *
 * The Blob's own facts are numbered exactly as `renderMemories` numbers them
 * in the prompt, so "forget 2" in chat and row 2 here are the same fact.
 * Shared facts are unnumbered for the same reason: the model addresses only
 * one list by position. Promotion between scopes is manual — the intent
 * router still writes Blob scope only.
 */
export function MemoriesModal({
  blobName,
  memories,
  userMemories,
  onChange,
  onClose,
}: MemoriesModalProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /**
   * Row awaiting a delete confirmation.
   *
   * In-row rather than a dialog: a modal over a modal is heavy for one fact,
   * and the pill replaces the two buttons in place, so the click target that
   * deletes is never where the click target that armed it was. A memory the
   * Blob spent a conversation learning should not go on one stray click.
   */
  const [confirming, setConfirming] = useState<string | null>(null);
  /**
   * Row playing its exit animation; deleted for real when that ends.
   *
   * Two-phase like `useExitAnimation`, for the same reason: a fact that blinks
   * out of a table while four rows jump up reads as a glitch, not as the thing
   * you just asked for.
   */
  const [leaving, setLeaving] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  /**
   * Live edit target, mirroring `editing`.
   *
   * Enter commits and unmounts the input, which can also fire `onBlur` — a
   * second commit whose closure still holds the old `editing` (React state
   * has not re-rendered yet), adding the same memory twice. Clearing this ref
   * inside `commit` makes the second call a no-op, and makes Escape actually
   * cancel instead of being undone by the blur behind it.
   */
  const target = useRef<string | null>(null);

  const startEdit = (id: string, text: string) => {
    // Editing a row disarms it: an armed "Delete?" sitting beside the input
    // you are typing into is one stray click from deleting the fact you were
    // halfway through rewording.
    setConfirming(null);
    target.current = id;
    setDraft(text);
    setEditing(id);
  };

  const cancel = () => {
    target.current = null;
    setEditing(null);
  };

  const rows = [
    ...memories.map((memory, index) => ({ memory, scope: "blob" as const, position: index + 1 })),
    ...userMemories.map((memory) => ({ memory, scope: "user" as const, position: 0 })),
  ];

  // Glide the survivors when a row leaves or changes scope. Keyed by the ids
  // in order, so an edit that only rewords a fact does not start a glide.
  useFlipRows(bodyRef, rows.map((row) => `${row.scope}:${row.memory.id}`).join());

  const listFor = (scope: "blob" | "user") => (scope === "blob" ? memories : userMemories);
  const patchFor = (scope: "blob" | "user", next: BlobMemory[]) =>
    scope === "blob" ? { blob: next } : { user: next };

  /**
   * Every edit here goes through the same reducer the `remember` tool and the
   * group router use, so a fact typed by hand is deduped, reconciled against
   * what it contradicts, and capped exactly like one the Blob saved itself.
   */
  const write = (scope: "blob" | "user", change: MemoryWrite) => {
    const result = applyMemoryWrite(listFor(scope), change);
    if (result.changed) {
      onChange(patchFor(scope, result.memories));
    }
  };

  const commit = () => {
    const editedId = target.current;
    target.current = null;
    setEditing(null);
    if (editedId === null) {
      return;
    }
    const text = draft.trim();
    const row = rows.find((candidate) => candidate.memory.id === editedId);
    if (row === undefined) {
      return;
    }
    // Emptying the text deletes the fact: the alternative is a blank row that
    // costs prompt space and says nothing.
    write(
      row.scope,
      text === "" ? { kind: "delete", ref: editedId } : { kind: "update", ref: editedId, text },
    );
  };

  const remove = (id: string, scope: "blob" | "user") => {
    setConfirming(null);
    // With motion reduced there is no animation and so no `animationend`:
    // waiting for one would leave the fact on screen forever.
    if (prefersReducedMotion()) {
      write(scope, { kind: "delete", ref: id });
      return;
    }
    setLeaving(id);
  };

  /**
   * Move a fact between scopes, keeping its id and createdAt.
   *
   * The fact is reconciled on arrival, so promoting "trains on Fridays" into a
   * shared scope that still says "trains on Mondays" replaces it instead of
   * leaving both for every Blob to read. It only leaves the source scope if
   * the destination accepted it: a destination that already knows the fact
   * rejects the write, and dropping it from the source anyway would delete a
   * memory the user asked to move. The full case never reaches here — the
   * button is disabled at the cap, because a user looking at the list should
   * prune it deliberately rather than have the oldest fact evicted under them.
   */
  const moveScope = (memory: BlobMemory, from: "blob" | "user") => {
    const to = from === "blob" ? "user" : "blob";
    const arrived = applyMemoryWrite(listFor(to), { kind: "adopt", memory });
    if (!arrived.changed) {
      return;
    }
    onChange({
      ...patchFor(
        from,
        listFor(from).filter((candidate) => candidate.id !== memory.id),
      ),
      ...patchFor(to, arrived.memories),
    });
  };

  const editor = (
    <input
      className="memory-input"
      value={draft}
      maxLength={MEMORY_TEXT_LIMIT}
      aria-label="Memory text"
      // biome-ignore lint/a11y/noAutofocus: the row was just clicked to edit it
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        } else if (event.key === "Escape") {
          cancel();
        }
      }}
    />
  );

  return (
    <ModalShell
      title="Memories"
      // Both scopes, because both reach the prompt. Hidden at zero: "(0)"
      // beside the title says nothing the empty state below does not say
      // better. Bracketed so it reads as a count of the heading rather than as
      // a stray number that could be mistaken for part of the title.
      {...(rows.length > 0 ? { titleNote: `(${rows.length})` } : {})}
      ariaLabel={`${blobName} memories`}
      onClose={onClose}
    >
      {rows.length === 0 ? (
        <p className="routines-empty-text">Facts this Blob learns as you talk show up here.</p>
      ) : (
        <table className="memories-table">
          <thead>
            <tr>
              {/* The number the model uses: "forget 2" and row 2 are the same
                  fact, so it is data, not decoration. */}
              <th scope="col" className="memories-col-position">
                #
              </th>
              <th scope="col">Memory</th>
              <th scope="col" className="memories-col-scope">
                Known by
              </th>
              <th scope="col" className="memories-col-actions">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {rows.map((row) => (
              <tr
                key={row.memory.id}
                data-flip-row={`${row.scope}:${row.memory.id}`}
                className={leaving === row.memory.id ? "memories-row-leaving" : undefined}
                onAnimationEnd={(event) => {
                  // The row's own exit, not an animation bubbling up from
                  // something inside it — a child's would commit the delete
                  // before the row had finished leaving. Same guard the modal
                  // backdrop uses for its own fade-out.
                  if (leaving === row.memory.id && event.target === event.currentTarget) {
                    setLeaving(null);
                    write(row.scope, { kind: "delete", ref: row.memory.id });
                  }
                }}
              >
                <td className="memories-col-position">
                  {row.scope === "blob" ? row.position : "—"}
                </td>
                <td>
                  {editing === row.memory.id ? (
                    editor
                  ) : (
                    <button
                      type="button"
                      className="memories-text"
                      onClick={() => startEdit(row.memory.id, row.memory.text)}
                    >
                      {row.memory.text}
                    </button>
                  )}
                </td>
                <td className="memories-col-scope">
                  {row.scope === "blob" ? blobName : "All Blobs"}
                </td>
                <td className="memories-col-actions">
                  {/* Wrapped so the pair can be centred on the first line of
                      the fact: the cell is top-aligned (a fact wraps to three
                      lines and the number must stay beside its first), which
                      left the buttons hanging below the text they act on. */}
                  <span className="memories-actions">
                    {confirming === row.memory.id ? (
                      <>
                        <button
                          type="button"
                          className="memories-confirm"
                          aria-label={`Confirm delete: ${row.memory.text}`}
                          onClick={() => remove(row.memory.id, row.scope)}
                        >
                          Delete?
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Keep memory"
                          onClick={() => setConfirming(null)}
                        >
                          <X size={15} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={
                            row.scope === "blob" ? "Share with all Blobs" : "Keep to this Blob only"
                          }
                          disabled={
                            listFor(row.scope === "blob" ? "user" : "blob").length >= MEMORY_LIMIT
                          }
                          onClick={() => moveScope(row.memory, row.scope)}
                        >
                          {row.scope === "blob" ? (
                            <Users size={15} strokeWidth={1.8} aria-hidden="true" />
                          ) : (
                            <User size={15} strokeWidth={1.8} aria-hidden="true" />
                          )}
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Delete memory: ${row.memory.text}`}
                          onClick={() => setConfirming(row.memory.id)}
                        >
                          <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ModalShell>
  );
}
