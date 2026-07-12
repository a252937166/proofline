import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import type { MatchCatalogEntry, MatchCatalogResponse } from "../types";

interface CaseSelectorProps {
  catalog: MatchCatalogResponse;
  activeMatchId: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
}

function readableMode(entry: MatchCatalogEntry): string {
  return entry.dataMode.replaceAll("-", " ");
}

function caseNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export function CaseSelector({ catalog, activeMatchId, disabled = false, onSelect }: CaseSelectorProps) {
  const selectedIndex = Math.max(0, catalog.matches.findIndex((entry) => entry.id === activeMatchId));
  const selected = catalog.matches[selectedIndex] ?? catalog.matches[0];
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const listboxId = "proofline-evidence-case-listbox";
  const selectedSummary = useMemo(
    () => selected ? `${selected.label} · ${readableMode(selected)}` : "Evidence case unavailable",
    [selected],
  );

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  if (!selected) return null;

  const focusOption = (index: number) => {
    const total = catalog.matches.length;
    const wrapped = (index + total) % total;
    setActiveIndex(wrapped);
    optionRefs.current[wrapped]?.focus();
  };

  const openAt = (index: number) => {
    setActiveIndex(index);
    setOpen(true);
  };

  const choose = (entry: MatchCatalogEntry) => {
    onSelect(entry.id);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const closeAndRestoreFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAt(open ? activeIndex + 1 : selectedIndex);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt(open ? activeIndex - 1 : selectedIndex);
    } else if (event.key === "Home") {
      event.preventDefault();
      openAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      openAt(catalog.matches.length - 1);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      closeAndRestoreFocus();
    }
  };

  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(catalog.matches.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={`header-case-selector${open ? " is-open" : ""}`} ref={rootRef}>
      <span className="case-selector-kicker">Evidence case</span>
      <button
        ref={triggerRef}
        className="case-selector-trigger"
        type="button"
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Evidence case: ${selectedSummary}`}
        disabled={disabled}
        onClick={() => open ? setOpen(false) : openAt(selectedIndex)}
        onKeyDown={onTriggerKeyDown}
        data-testid="match-selector-trigger"
      >
        <span className="case-selector-trigger__copy" title={selectedSummary}>
          <strong>{selected.label}</strong>
          <small>{readableMode(selected)}</small>
        </span>
        <span className="case-selector-chevron" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="m3 6 5 5 5-5" /></svg>
        </span>
      </button>
      <input type="hidden" value={selected.id} readOnly data-testid="match-selector" />

      {open && (
        <div className="case-selector-menu" data-testid="match-selector-menu">
          <div className="case-selector-menu__head">
            <span>Case manifest</span>
            <small>{catalog.matches.length} evidence states</small>
          </div>
          <div className="case-selector-options" id={listboxId} role="listbox" aria-label="Available evidence cases">
            {catalog.matches.map((entry, index) => {
              const isSelected = entry.id === selected.id;
              return (
                <button
                  key={entry.id}
                  ref={(node) => { optionRefs.current[index] = node; }}
                  className="case-selector-option"
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onClick={() => choose(entry)}
                  onKeyDown={(event) => onOptionKeyDown(event, index)}
                  data-testid={`match-option-${entry.id}`}
                >
                  <span className="case-selector-option__index">{caseNumber(index)}</span>
                  <span className="case-selector-option__copy">
                    <strong>{entry.label}</strong>
                    <small>{entry.id}</small>
                  </span>
                  <span className="case-selector-option__mode" data-mode={entry.dataMode}>
                    {readableMode(entry)}
                  </span>
                  <span className="case-selector-option__check" aria-hidden="true">
                    {isSelected ? "✓" : "↗"}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="case-selector-menu__note">Selection updates the evidence workspace. No proof or payment is executed.</p>
        </div>
      )}
    </div>
  );
}
