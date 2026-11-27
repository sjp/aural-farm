import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { MAX_NAME_LENGTH, sanitizeName } from "../mixes/mix";
import { MAX_SAVED_MIXES } from "../mixes/mixes";
import { CloseIcon, PencilIcon, TrashIcon } from "./icons";

/** A preset or saved mix, as a row shows it. */
export interface MixEntry {
  name: string;
  /** One line: a preset's description, or a saved mix's sounds. */
  description: string;
  /** Its sounds' ids and tints, in order. */
  sounds: readonly { id: string; tint: string }[];
  /** Whether it is the mix playing now, unchanged. */
  current: boolean;
}

/** Everything the Mixes view shows and does; the app keeps the mixes and applies them. */
export interface MixesControls {
  /** Whether the Mixes view has taken over the panel. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presets: readonly MixEntry[];
  /** The saved mixes, newest first. */
  saved: readonly MixEntry[];
  /** What "Save mix…" offers as the name: the mix's name, or its sounds. */
  suggestedName: string;
  /** Whether the mix has any sounds to save. */
  canSave: boolean;
  /** The saved mix called `name`, ignoring case, if any. */
  findSaved: (name: string) => string | undefined;
  onApplyPreset: (index: number) => void;
  onApplySaved: (name: string) => void;
  /** Saves the mix as `name`, replacing any mix of that name. */
  onSave: (name: string) => void;
  onRename: (from: string, to: string) => void;
  onDelete: (name: string) => void;
  onExport: () => void;
  onImport: (file: File) => void;
  /** Names an imported file would replace, while it waits for an answer. */
  importConflicts: readonly string[] | undefined;
  /** Answers the question: replace them, keep the saved ones, or (undefined) cancel the import. */
  onImportAnswer: (replace: boolean | undefined) => void;
}

/** Where focus goes next: Save mix…, a saved mix's row, or its Rename button. */
type FocusTarget = { to: "save" } | { to: "row" | "rename"; name: string };

/** Where "Save mix…" is: not started, asking for a name, or asking to replace. */
type SaveStep =
  | { step: "idle" }
  | { step: "naming" }
  | { step: "replace"; name: string; existing: string };

/** A preset's or saved mix's row: its tint dots, name and one line, as a button that applies it. */
function MixOption({ entry, onApply }: { entry: MixEntry; onApply: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="picker-option mix-option"
      data-mix-name={entry.name}
      aria-current={entry.current ? "true" : undefined}
      onClick={onApply}
    >
      <span className="mix-dots" aria-hidden="true">
        {entry.sounds.map((sound) => (
          <span key={sound.id} className="layer-dot" style={{ "--tint": sound.tint }} />
        ))}
      </span>
      <span className="picker-text">
        <span className="picker-name">{entry.name}</span>
        <span className="picker-description">{entry.description}</span>
      </span>
      {entry.current && <span className="picker-in-mix">Playing</span>}
    </button>
  );
}

/** A one-field form for a mix's name, with Save and Cancel. Esc cancels. */
function NameForm({
  label,
  initial,
  submitLabel,
  error,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  submitLabel: string;
  error?: string | undefined;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);
  const empty = sanitizeName(value) === "";
  return (
    <form
      className="mix-name-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) {
          onSubmit(value);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        className="mix-name-input"
        aria-label={label}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        aria-invalid={error === undefined ? undefined : true}
        maxLength={MAX_NAME_LENGTH * 2}
        autoComplete="off"
        enterKeyHint="done"
        value={value}
        onInput={(event) => {
          setValue(event.currentTarget.value);
        }}
      />
      <div className="mix-form-actions">
        <button type="submit" className="primary" disabled={empty}>
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error !== undefined && (
        <p id={`${id}-error`} className="mix-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** A question with its answers, shown in place of the save button. */
function Question({
  text,
  children,
}: {
  text: string;
  children: JSX.Element | JSX.Element[];
}): JSX.Element {
  return (
    <div className="mix-question" role="group" aria-label={text}>
      <p>{text}</p>
      <div className="mix-form-actions">{children}</div>
    </div>
  );
}

/**
 * The Mixes view, which takes over the panel like the sound picker: "Save
 * mix…", then the built-in presets and the saved mixes, each row applying its
 * mix, and saved rows with Rename and Delete. The footer exports and imports a
 * backup file. Esc closes it (or cancels whatever is being typed first).
 */
export function MixesView({
  controls,
  hover,
  onClose,
}: {
  controls: MixesControls;
  hover: boolean;
  onClose: () => void;
}): JSX.Element {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | undefined>({ to: "save" });
  const [save, setSave] = useState<SaveStep>({ step: "idle" });
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [renameError, setRenameError] = useState<string | undefined>(undefined);
  const full = controls.saved.length >= MAX_SAVED_MIXES;

  // Moves focus once its target has rendered, so it isn't lost when a form or row goes.
  useEffect(() => {
    if (!focusTarget) {
      return;
    }
    setFocusTarget(undefined);
    const find = (selector: string, name: string) =>
      Array.from(rootRef.current?.querySelectorAll<HTMLElement>(selector) ?? []).find(
        (element) => (element.dataset.mixName ?? element.getAttribute("aria-label")) === name,
      );
    const element =
      focusTarget.to === "save"
        ? undefined
        : focusTarget.to === "row"
          ? find("[data-mix-name]", focusTarget.name)
          : find(".mix-rename", `Rename ${focusTarget.name}`);
    (element ?? saveRef.current)?.focus({ preventScroll: true });
  }, [focusTarget]);

  const finishSave = () => {
    setSave({ step: "idle" });
    setFocusTarget({ to: "save" });
  };

  const submitName = (raw: string) => {
    const name = sanitizeName(raw);
    const existing = controls.findSaved(name);
    if (existing !== undefined) {
      setSave({ step: "replace", name, existing });
    } else if (!full) {
      controls.onSave(name);
      finishSave();
    }
  };

  const submitRename = (from: string, raw: string) => {
    const to = sanitizeName(raw);
    const existing = controls.findSaved(to);
    if (existing !== undefined && existing !== from) {
      setRenameError(`There's already a mix called ${existing}.`);
      return;
    }
    controls.onRename(from, to);
    setRenaming(undefined);
    setRenameError(undefined);
    setFocusTarget({ to: "rename", name: to });
  };

  /** Deletes a saved mix, moving focus to the next row (or the one before, or Save mix…). */
  const remove = (name: string) => {
    const index = controls.saved.findIndex((m) => m.name === name);
    const neighbour =
      controls.saved.at(index + 1) ?? (index > 0 ? controls.saved.at(index - 1) : undefined);
    controls.onDelete(name);
    setFocusTarget(neighbour ? { to: "row", name: neighbour.name } : { to: "save" });
  };

  const presetsTitle = `${id}-presets`;
  const savedTitle = `${id}-saved`;

  let saveArea: JSX.Element;
  if (save.step === "naming") {
    saveArea = (
      <NameForm
        label="Mix name"
        initial={controls.suggestedName}
        submitLabel="Save"
        onSubmit={submitName}
        onCancel={finishSave}
      />
    );
  } else if (save.step === "replace") {
    saveArea = (
      <Question text={`Replace ${save.existing}?`}>
        <button
          type="button"
          className="primary"
          onClick={() => {
            controls.onSave(save.name);
            finishSave();
          }}
        >
          Replace
        </button>
        <button type="button" onClick={finishSave}>
          Cancel
        </button>
      </Question>
    );
  } else {
    saveArea = (
      <button
        ref={saveRef}
        type="button"
        className="add-button"
        disabled={!controls.canSave}
        onClick={() => {
          setSave({ step: "naming" });
        }}
      >
        Save mix…
      </button>
    );
  }

  return (
    <div
      ref={rootRef}
      className="picker mixes"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="panel-header picker-header">
        <div className="panel-header-row">
          <h2 className="panel-title">Mixes</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close mixes"
            title={hover ? "Close mixes (Esc)" : "Close mixes"}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="mix-save">
          {full && save.step === "naming" && (
            <p className="picker-banner" role="note">
              {MAX_SAVED_MIXES} mixes is the most there's room for. Delete one to save another, or
              save over one by its name.
            </p>
          )}
          {saveArea}
          {!controls.canSave && save.step === "idle" && (
            <p className="hint mix-save-hint">Add a sound to save a mix</p>
          )}
        </div>
        {controls.importConflicts && (
          <Question
            text={`${controls.importConflicts.join(", ")} ${
              controls.importConflicts.length === 1 ? "is" : "are"
            } already saved. Replace with the file's?`}
          >
            <button
              type="button"
              className="primary"
              onClick={() => {
                controls.onImportAnswer(true);
              }}
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => {
                controls.onImportAnswer(false);
              }}
            >
              Keep mine
            </button>
            <button
              type="button"
              onClick={() => {
                controls.onImportAnswer(undefined);
              }}
            >
              Cancel
            </button>
          </Question>
        )}
      </header>
      <div className="picker-body">
        <div className="picker-group" role="group" aria-labelledby={presetsTitle}>
          <div id={presetsTitle} className="picker-group-title">
            Presets
          </div>
          {controls.presets.map((entry, index) => (
            <div key={entry.name} className="picker-row">
              <MixOption
                entry={entry}
                onApply={() => {
                  controls.onApplyPreset(index);
                }}
              />
            </div>
          ))}
        </div>
        <div className="picker-group" role="group" aria-labelledby={savedTitle}>
          <div id={savedTitle} className="picker-group-title">
            My mixes
          </div>
          {controls.saved.length === 0 && (
            <p className="hint picker-hint">Mixes you save appear here, kept in this browser</p>
          )}
          {controls.saved.map((entry) =>
            renaming === entry.name ? (
              <div key={entry.name} className="picker-row mix-renaming">
                <NameForm
                  label={`New name for ${entry.name}`}
                  initial={entry.name}
                  submitLabel="Rename"
                  error={renameError}
                  onSubmit={(name) => {
                    submitRename(entry.name, name);
                  }}
                  onCancel={() => {
                    setRenaming(undefined);
                    setRenameError(undefined);
                    setFocusTarget({ to: "rename", name: entry.name });
                  }}
                />
              </div>
            ) : (
              <div key={entry.name} className="picker-row">
                <MixOption
                  entry={entry}
                  onApply={() => {
                    controls.onApplySaved(entry.name);
                  }}
                />
                <button
                  type="button"
                  className="icon-button mix-action mix-rename"
                  aria-label={`Rename ${entry.name}`}
                  title="Rename"
                  onClick={() => {
                    setRenaming(entry.name);
                    setRenameError(undefined);
                  }}
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  className="icon-button mix-action"
                  aria-label={`Delete ${entry.name}`}
                  title="Delete"
                  onClick={() => {
                    remove(entry.name);
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
            ),
          )}
        </div>
      </div>
      <footer className="panel-footer">
        <div className="footer-actions">
          <button
            type="button"
            className="text-button"
            disabled={controls.saved.length === 0}
            onClick={controls.onExport}
          >
            Export my mixes
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              fileRef.current?.click();
            }}
          >
            Import…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label="Import mixes file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) {
                controls.onImport(file);
              }
            }}
          />
        </div>
      </footer>
    </div>
  );
}
