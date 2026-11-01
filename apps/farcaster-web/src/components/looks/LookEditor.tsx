/**
 * Making a look — the editor, and the door out of it.
 *
 * WHAT IT IS NOT. There is no stylesheet here, no code box, no colour code a
 * person has to type. Every control is a picker that can only produce one of the
 * values the model already allows (`~/utils/lookTheme.ts`): a colour control
 * yields `#rrggbb`, a slider yields a whole number in range, the face is one of
 * the three this client already has. Someone cannot write CSS into their look
 * from here, which is why the same look can be stored and handed to a stranger
 * without anyone having to trust it.
 *
 * THE PREVIEW IS FIDDY. The draft is applied to the client while it is open
 * (`applyLook`), so the person is looking at their own Fiddy changing, not at a
 * picture of it — and it is put back the way it was on the way out unless they
 * saved it. The little window above the controls is the same drawing as the card
 * a shared link leaves in a feed, so what they hand over is what they see.
 *
 * LAZY ON PURPOSE. This file, the colour controls and the share call live in
 * their own chunk (`~/lazy/components`), never in the entry chunk: nobody needs
 * an editor to read a feed.
 */

import React from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { LookPreview } from '~/components/looks/LookPreview';
import { DefaultModalContainer } from '~/components/modals/DefaultModalContainer';
import { DefaultModalHeader } from '~/components/modals/DefaultModalHeader';
import { Modal } from '~/components/modals/Modal';
import { useWornLook } from '~/hooks/theme/useWornLook';
import { shareLook } from '~/lib/lookShare';
import {
  applyLook,
  cleanLook,
  DEFAULT_LOOK,
  FIDDY_LOOK,
  Look,
  LOOK_FONTS,
  LOOK_LIMITS,
  LookFont,
  LookToken,
  lookUrl,
  lookVars,
} from '~/utils/lookTheme';
import { toast } from '~/utils/toast';

type LookEditorProps = {
  /** What to start from: the look being worn, or the brand. */
  initial?: Look;
  onClose: () => void;
};

/** The colours, in the order a person thinks about them. */
const GROUPS: { title: string; hint: string; tokens: LookToken[] }[] = [
  {
    title: 'The page',
    hint: 'Behind everything',
    tokens: ['bg', 'card', 'soft'],
  },
  {
    title: 'Words and lines',
    hint: 'Text, quiet text, lines, edges',
    tokens: ['ink', 'muted', 'line', 'border'],
  },
  {
    title: 'The bright bit',
    hint: 'Buttons and highlights',
    tokens: ['accent', 'onAccent'],
  },
  {
    title: 'Reactions',
    hint: 'Likes and recasts',
    tokens: ['like', 'recast'],
  },
];

const TOKEN_LABELS: Record<LookToken, string> = {
  bg: 'Background',
  card: 'Panels',
  soft: 'Quiet panels',
  ink: 'Text',
  muted: 'Quiet text',
  line: 'Lines',
  border: 'Edges',
  accent: 'Accent',
  onAccent: 'Text on the accent',
  like: 'Likes',
  recast: 'Recasts',
};

const FONT_LABELS: Record<LookFont, string> = {
  rounded: 'Rounded',
  inter: 'Plain',
  mono: 'Fixed',
};

const LookEditor: React.FC<LookEditorProps> = ({ initial, onClose }) => {
  const { wornLook, putOnLook } = useWornLook();

  /** The look being made. Every token is present, so every control has a value. */
  const [draft, setDraft] = React.useState<Look>(() => ({
    ...DEFAULT_LOOK,
    ...(initial ?? wornLook ?? FIDDY_LOOK),
  }));
  const [name, setName] = React.useState<string>(
    () => (initial ?? wornLook ?? FIDDY_LOOK).name ?? '',
  );
  const [share, setShare] = React.useState<
    | { state: 'idle' }
    | { state: 'busy' }
    | { state: 'done'; link: string }
    | { state: 'error'; error: string }
  >({ state: 'idle' });
  const [saved, setSaved] = React.useState(false);

  const preview: Look = React.useMemo(
    () => ({ ...draft, name: name.trim() || undefined }),
    [draft, name],
  );
  /** The draft's own variables, for the controls that show them off. */
  const previewVars = React.useMemo(
    () => lookVars(preview) as React.CSSProperties,
    [preview],
  );

  // Live: the client wears the draft while the editor is open.
  React.useEffect(() => {
    applyLook(preview);
  }, [preview]);

  // ...and is handed back untouched on the way out, unless it was saved.
  React.useEffect(
    () => () => {
      applyLook(wornLook);
    },
    [wornLook],
  );

  const setColor = React.useCallback((token: LookToken, value: string) => {
    setDraft((current) => ({ ...current, [token]: value }));
    setSaved(false);
    setShare({ state: 'idle' });
  }, []);

  const setWhole = React.useCallback(
    (key: 'round' | 'borderWidth', value: number) => {
      setDraft((current) => ({ ...current, [key]: value }));
      setSaved(false);
      setShare({ state: 'idle' });
    },
    [],
  );

  const onPutOn = React.useCallback(() => {
    const look = cleanLook(preview);
    if (!Object.keys(look).length) {
      return;
    }
    putOnLook(look);
    setSaved(true);
    toast({ message: 'Saved — you can undo this' });
  }, [preview, putOnLook]);

  const onShare = React.useCallback(() => {
    setShare({ state: 'busy' });
    shareLook(cleanLook(preview)).then((result) => {
      setShare(
        result.ok
          ? { state: 'done', link: lookUrl(result.id) }
          : { state: 'error', error: result.error },
      );
    });
  }, [preview]);

  const onCopy = React.useCallback((link: string) => {
    navigator.clipboard.writeText(link);
    toast({ message: 'Link copied' });
  }, []);

  return (
    <Modal>
      <DefaultModalContainer onClose={onClose}>
        <div className="flex size-full items-center justify-center p-4">
          <div
            className="flex max-h-full w-full max-w-lg flex-col overflow-y-auto rounded-lg bg-app border-default"
            onClick={(event) => {
              event.stopPropagation();
            }}
            data-fiddy="look-editor"
          >
            <DefaultModalHeader title="Make Fiddy yours" onClose={onClose} />

            <div className="flex flex-col gap-5 p-6">
              <LookPreview look={preview} />

              <label className="flex flex-col gap-1">
                <span className="text-sm font-semibold">Call it</span>
                <input
                  data-fiddy="look-name"
                  type="text"
                  value={name}
                  maxLength={LOOK_LIMITS.name}
                  placeholder="My look"
                  onChange={(event) => {
                    setName(event.target.value.slice(0, LOOK_LIMITS.name));
                    setSaved(false);
                  }}
                  className="w-full rounded-md px-3 py-2 bg-app border-default text-default"
                />
              </label>

              {GROUPS.map((group) => (
                <div key={group.title} className="flex flex-col gap-2">
                  <div>
                    <p className="text-sm font-semibold">{group.title}</p>
                    <p className="text-xs text-faint">{group.hint}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {group.tokens.map((token) => (
                      <label
                        key={token}
                        className="flex items-center gap-2 rounded-md p-2 border-default"
                      >
                        <input
                          data-fiddy={`look-colour-${token}`}
                          type="color"
                          aria-label={TOKEN_LABELS[token]}
                          value={draft[token] ?? DEFAULT_LOOK[token]}
                          onChange={(event) => {
                            setColor(token, event.target.value);
                          }}
                          className="h-7 w-9 flex-none rounded border-0 bg-transparent p-0"
                        />
                        <span className="truncate text-xs">
                          {TOKEN_LABELS[token]}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-semibold">
                    Corners — {draft.round ?? DEFAULT_LOOK.round}
                  </span>
                  <input
                    data-fiddy="look-round"
                    type="range"
                    min={0}
                    max={LOOK_LIMITS.round}
                    value={draft.round ?? DEFAULT_LOOK.round}
                    onChange={(event) => {
                      setWhole('round', Number(event.target.value));
                    }}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm font-semibold">
                    Edges — {draft.borderWidth ?? DEFAULT_LOOK.borderWidth}
                  </span>
                  <input
                    data-fiddy="look-border"
                    type="range"
                    min={0}
                    max={LOOK_LIMITS.borderWidth}
                    value={draft.borderWidth ?? DEFAULT_LOOK.borderWidth}
                    onChange={(event) => {
                      setWhole('borderWidth', Number(event.target.value));
                    }}
                  />
                </label>

                <div className="flex flex-col gap-1">
                  <span className="text-sm font-semibold">Type</span>
                  <div className="flex gap-2">
                    {(Object.keys(LOOK_FONTS) as LookFont[]).map((font) => (
                      <button
                        key={font}
                        type="button"
                        data-fiddy={`look-font-${font}`}
                        aria-pressed={draft.font === font}
                        onClick={() => {
                          setDraft((current) => ({ ...current, font }));
                          setSaved(false);
                        }}
                        className={
                          draft.font === font
                            ? 'fiddy-look-chip'
                            : 'fiddy-look-chip-quiet'
                        }
                        style={previewVars}
                      >
                        {FONT_LABELS[font]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-sm font-semibold">Day or night</span>
                  <div className="flex gap-2">
                    {(['dark', 'light'] as const).map((base) => (
                      <button
                        key={base}
                        type="button"
                        data-fiddy={`look-base-${base}`}
                        aria-pressed={(draft.base ?? 'dark') === base}
                        onClick={() => {
                          setDraft((current) => ({ ...current, base }));
                          setSaved(false);
                        }}
                        className={
                          (draft.base ?? 'dark') === base
                            ? 'fiddy-look-chip'
                            : 'fiddy-look-chip-quiet'
                        }
                        style={previewVars}
                      >
                        {base === 'dark' ? 'Night' : 'Day'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <DefaultButton
                  data-fiddy="look-put-on"
                  onClick={onPutOn}
                  disabled={saved}
                >
                  {saved ? 'Saved' : 'Put this look on'}
                </DefaultButton>
                <DefaultButton
                  data-fiddy="look-share"
                  variant="secondary"
                  isLoading={share.state === 'busy'}
                  onClick={onShare}
                >
                  Share this look
                </DefaultButton>
              </div>

              {share.state === 'done' && (
                <div
                  className="flex flex-col gap-2 rounded-md p-3 border-default"
                  data-fiddy="look-share-link"
                >
                  <p className="text-sm">
                    Anyone who opens this link sees your look and can put it on.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={share.link}
                      onFocus={(event) => event.target.select()}
                      className="min-w-0 flex-1 rounded-md px-2 py-1 text-xs bg-app border-default text-default"
                    />
                    <DefaultButton
                      size="sm"
                      variant="secondary"
                      onClick={() => onCopy(share.link)}
                    >
                      Copy
                    </DefaultButton>
                  </div>
                </div>
              )}

              {share.state === 'error' && (
                <p
                  className="text-sm text-danger"
                  data-fiddy="look-share-error"
                >
                  {share.error}
                </p>
              )}

              {saved && (
                <p className="text-sm text-faint" data-fiddy="look-saved">
                  Saved — you can undo this from Theme whenever you like.
                </p>
              )}
            </div>
          </div>
        </div>
      </DefaultModalContainer>
    </Modal>
  );
};

export { LookEditor };
