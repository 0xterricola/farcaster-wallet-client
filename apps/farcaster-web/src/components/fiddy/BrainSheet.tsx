/**
 * "Add a brain" — the surface the positioning pivot turns on.
 *
 * One card per service, in plain words, and one honest line about who owns the
 * key. There are three kinds of card, and the difference is what the owner has
 * to bring:
 *
 *   Fiddy          built in. Works out of the box, nothing to plug in.
 *   ChatGPT, Claude, Gemini, OpenRouter, Nous Portal
 *                  a service they already pay for: one key, one model name. The
 *                  address is ours, so they are never asked for it.
 *   Surp           pay as you go — the same preset shape, with the one thing
 *                  the others cannot say: what a month would actually cost,
 *                  computed from Surp's live prices against the plan it
 *                  replaces, and a key made here in one press (SurpBrainPanel).
 *   Your own AI service
 *                  anything OpenAI-compatible they run or bought: an address, a
 *                  key and a model name.
 *
 * The "test connection" button asks the agent service to read the service's model
 * list once. If the owner is paired with an agent, the button under it applies
 * the choice to that agent for real; if nobody is paired yet (this is also a step
 * on the way in), the choice is kept on this device and the copy says exactly
 * that, because a button that looks live and is not is the dishonesty this card
 * exists to remove.
 *
 * The key is handled in one place and never leaves it: it is component state,
 * passed to the agent service for the check and for the apply, never written
 * into the setup file, and never shown in full on this screen. There is one
 * honest exception, and the screen says so where it happens: a key Surp's own
 * panel makes did not exist anywhere before it was made there, so that panel
 * keeps it in the browser (its own storage entry — `lib/surp/keys.ts`) and this
 * sheet only ever shows a mask of it.
 */

import React, { memo, useCallback, useEffect, useState } from 'react';

import { useAgentSession } from '~/hooks/agent/useAgentSession';
import {
  AgentServiceError,
  type AgentSummary,
  applyBrain,
  type BrainChoice,
  type BrainProbe,
  listAgents,
  probeBrain,
} from '~/lib/agentService';
import {
  type BrainId,
  type FiddySetup,
  saveFiddySetup,
  useFiddySetup,
} from '~/lib/fiddySetup';

import { SurpBrainPanel } from './SurpBrainPanel';

interface BrainCard {
  id: BrainId;
  title: string;
  tag: string;
  tagKind: 'live' | 'yours';
  line: string;
  /** What this card needs from the owner. */
  needs: 'nothing' | 'account' | 'address';
  /** For display only: where a preset sends it. The service knows its own address. */
  where?: string;
  /** The kind of choice this card makes when it is applied. */
  kind: 'default' | 'preset' | 'custom';
}

export const BRAIN_CARDS: BrainCard[] = [
  {
    id: 'fiddy',
    title: 'Fiddy',
    tag: 'works out of the box',
    tagKind: 'live',
    line: "Works out of the box — Fiddy's built-in brain. Nothing to plug in, nothing to paste, and it keeps working when this tab is closed.",
    needs: 'nothing',
    kind: 'default',
  },
  {
    id: 'surp',
    title: 'Surp',
    tag: 'pay as you go',
    tagKind: 'live',
    line: 'Pay only for the requests you actually make, and see what a month would cost before you spend anything. The key is made here, in one press.',
    needs: 'account',
    where: 'surp.ivc.lol',
    kind: 'preset',
  },
  {
    id: 'openai',
    title: 'ChatGPT',
    tag: 'your account',
    tagKind: 'yours',
    line: 'Use the ChatGPT plan you already pay for. You bring one key and one model name.',
    needs: 'account',
    where: 'api.openai.com',
    kind: 'preset',
  },
  {
    id: 'anthropic',
    title: 'Claude',
    tag: 'your account',
    tagKind: 'yours',
    line: 'Use the Claude plan you already pay for. You bring one key and one model name.',
    needs: 'account',
    where: 'api.anthropic.com',
    kind: 'preset',
  },
  {
    id: 'google',
    title: 'Gemini',
    tag: 'your account',
    tagKind: 'yours',
    line: 'Use your Google AI Studio key. You bring it and the model name you want.',
    needs: 'account',
    where: 'generativelanguage.googleapis.com',
    kind: 'preset',
  },
  {
    id: 'openrouter',
    title: 'OpenRouter',
    tag: 'one key, many models',
    tagKind: 'yours',
    line: 'One key, lots of models, pay for what you use. You bring the key and a model name.',
    needs: 'account',
    where: 'openrouter.ai',
    kind: 'preset',
  },
  {
    id: 'nous',
    title: 'Nous Portal',
    tag: 'your account',
    tagKind: 'yours',
    line: "Nous Research's own portal. You bring your key and a model name.",
    needs: 'account',
    where: 'inference-api.nousresearch.com',
    kind: 'preset',
  },
  {
    id: 'custom',
    title: 'Your own AI service',
    tag: 'you bring it',
    tagKind: 'yours',
    line: 'Any AI service you run or bought, as long as it keeps to the common shape: an address, a key, a model name.',
    needs: 'address',
    kind: 'custom',
  },
];

export const brainCard = (id: BrainId): BrainCard =>
  BRAIN_CARDS.find((card) => card.id === id) ?? BRAIN_CARDS[0];

/** One plain sentence for whichever brain is selected, for summary lines. */
export const brainSummary = (setup: FiddySetup): string => {
  const card = brainCard(setup.brain);
  if (setup.brain === 'fiddy') {
    return 'Fiddy, built in';
  }
  const model = setup.brainModel ? ` — ${setup.brainModel}` : '';
  if (setup.brain === 'custom') {
    return setup.brainServiceUrl
      ? `Your own service (${setup.brainServiceUrl.replace('https://', '')})${model}`
      : 'Your own service — not set up yet';
  }
  // Surp is not "your account": there is no account, and the whole point is
  // that it is billed per request against a key you made here.
  if (setup.brain === 'surp') {
    return `${card.title} — pay as you go${model}`;
  }
  return `${card.title} — your account${model}`;
};

/**
 * Every failure says what failed, in words an owner can act on. The service
 * answers with a code; this is where the code becomes a sentence, because the
 * sentence is product copy and belongs with the rest of it.
 */
const PLAIN_WORDS: Record<string, string> = {
  BRAIN_KEY_REFUSED:
    'That key was not accepted for that service. Check both and try again.',
  BRAIN_KEY_INVALID:
    'That key does not look like a key. Copy it exactly as your service gave it to you.',
  BRAIN_KEY_REQUIRED: 'That service needs its key. Paste it, then try again.',
  BRAIN_ADDRESS_NOT_PUBLIC:
    'That address is on a private network, so your agent could not reach it. Use the public address your service gave you.',
  BRAIN_ADDRESS_NOT_HTTPS:
    'That address has to start with https://. Anything else would send your key in the open.',
  BRAIN_ADDRESS_INVALID:
    'That address is not usable. It should look like https://api.example.com/v1.',
  BRAIN_ADDRESS_UNRESOLVED:
    'That address did not look up. Check the spelling and try again.',
  BRAIN_MODEL_INVALID:
    'That model name does not look right. Copy it exactly as your service writes it.',
  BRAIN_NO_MODEL_LIST:
    'Your service answered, but it does not publish a list of models, so we could not check it from here. It may well work anyway.',
  BRAIN_NO_MODELS:
    'Your service answered, but listed no models. Check that this is the AI service address and not its dashboard.',
  BRAIN_NOT_JSON:
    'Something answered at that address, but it is not an AI service.',
  BRAIN_SERVICE_ERROR:
    'That service answered with an error. Try again in a moment.',
  BRAIN_RESPONSE_TOO_LARGE:
    'That address answered with something far too large to be a list of models.',
  BRAIN_TIMEOUT:
    'That address took too long to answer. Try again, or check that it is running.',
  BRAIN_UNREACHABLE: 'That address did not answer. Check it and try again.',
  BRAIN_PRESET_NOT_APPROVED:
    'That service is not one we can fill in for you. Use your own AI service instead.',
  RATE_LIMITED: 'Too many tries in a row. Wait a minute and try again.',
  ORIGIN_NOT_ALLOWED:
    'Fiddy could not run that check from this page. Try again from Fiddy itself.',
  NOT_PAIRED: 'Connect to your agent service first, then try again.',
};

const plainWords = (error: unknown): string => {
  if (error instanceof AgentServiceError) {
    return (
      PLAIN_WORDS[error.code] ??
      'Fiddy could not run that check just now. Try again in a moment.'
    );
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'That took too long. Try again.';
  }
  return 'Fiddy could not run that check just now. Try again in a moment.';
};

const probeSentence = (probe: BrainProbe): string => {
  if (probe.ok) {
    return probe.models.length === 1
      ? 'That key works — 1 model there.'
      : `That key works — ${probe.models.length} models there.`;
  }
  return PLAIN_WORDS[probe.code] ?? 'That check did not work. Try again.';
};

/**
 * Surp's own sentences. Every other card can promise "Fiddy keeps no copy of
 * your key", because that key already exists on the owner's own dashboard and
 * only passes through. Surp's key does not exist anywhere until this screen
 * makes it, so the honest version says where it does live — in this browser,
 * readable by this page, and nowhere else.
 */
const SURP_LINES = {
  heading: 'Pay as you go — here is what it would cost.',
  sub: 'It connects to surp.ivc.lol. This key is made here and kept in this browser; Fiddy keeps no other copy of it.',
  keptWhenApplied:
    'Your key is set on your own agent. The copy in this browser stays here, and nothing else keeps one.',
  keptHere:
    'Saved in this browser, so you will not have to paste it again. Nothing else keeps a copy.',
};

export const BrainSheet = memo(() => {
  const setup = useFiddySetup();
  const { status, session } = useAgentSession();

  const [openId, setOpenId] = useState<BrainId | null>(null);
  const [address, setAddress] = useState(setup.brainServiceUrl ?? '');
  const [key, setKey] = useState('');
  const [model, setModel] = useState(setup.brainModel ?? '');
  const [busy, setBusy] = useState<'probe' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);

  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [agentId, setAgentId] = useState<string>('');

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [toolServer, setToolServer] = useState(setup.toolServerUrl ?? '');
  const [toolServerSaved, setToolServerSaved] = useState(false);

  const paired = status === 'paired' && session !== null;
  const card = openId ? brainCard(openId) : null;

  /**
   * A key made in Surp's panel is usable here and now: it goes into the field
   * below, so "test connection" and "use this brain" work without the owner
   * copying a string from one box into another on the same screen. It stays
   * component state — the setup file still holds no credential.
   */
  const keepKey = useCallback((value: string) => setKey(value), []);

  // Which agent would be changed. Listed only when there is a service to ask;
  // a failure here is not an error on this screen — the sheet still works, it
  // just cannot apply anything.
  useEffect(() => {
    if (!paired || !session) {
      setAgents(null);
      setAgentId('');
      return;
    }
    let cancelled = false;
    listAgents(session)
      .then((listed) => {
        if (cancelled) {
          return;
        }
        setAgents(listed);
        setAgentId((current) => current || listed[0]?.id || '');
      })
      .catch(() => {
        if (!cancelled) {
          setAgents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [paired, session]);

  const choose = (id: BrainId) => {
    setError(null);
    setNotice(null);
    setModels([]);
    if (id === 'fiddy') {
      // Nothing to plug in: the built-in brain is a choice, and it is made here.
      saveFiddySetup({
        brain: 'fiddy',
        brainModel: null,
        brainServiceUrl: null,
      });
      setOpenId(null);
      setNotice('Fiddy will think with its built-in brain.');
      return;
    }
    setOpenId(id);
    const chosen = brainCard(id);
    if (chosen.needs === 'address') {
      setAddress(setup.brain === 'custom' ? (setup.brainServiceUrl ?? '') : '');
    }
    setModel(setup.brain === id ? (setup.brainModel ?? '') : '');
  };

  const choice = useCallback((): BrainChoice | null => {
    if (!card) {
      return null;
    }
    const trimmedModel = model.trim();
    // Asked in the order the fields appear, so the sentence matches the thing.
    if (card.needs === 'address' && !address.trim()) {
      setError(
        'What is the address of your service? It looks like https://api.example.com/v1.',
      );
      return null;
    }
    if (!key.trim()) {
      setError('Paste the key your service gave you.');
      return null;
    }
    if (!trimmedModel) {
      setError(
        'Which model should it use? Your service will tell you the name.',
      );
      return null;
    }
    return card.kind === 'preset'
      ? {
          kind: 'preset',
          presetId: card.id,
          model: trimmedModel,
          key: key.trim(),
        }
      : {
          kind: 'custom',
          baseUrl: address.trim(),
          model: trimmedModel,
          key: key.trim(),
        };
  }, [address, card, key, model]);

  const test = async () => {
    setError(null);
    setNotice(null);
    setModels([]);
    const chosen = choice();
    if (!chosen) {
      return;
    }
    setBusy('probe');
    try {
      const probe = await probeBrain(session, chosen);
      // A check that did not work is a failure, and it is announced as one. A
      // service's own "no, that key was refused" is the same failure as a
      // transport error, so it does not get to arrive quietly as a status.
      if (probe.ok) {
        setNotice(probeSentence(probe));
      } else {
        setError(probeSentence(probe));
      }
      setModels(probe.models);
    } catch (caught) {
      setError(plainWords(caught));
    } finally {
      setBusy(null);
    }
  };

  const use = async () => {
    setError(null);
    setNotice(null);
    const chosen = choice();
    if (!chosen) {
      return;
    }
    if (paired && session && agentId) {
      setBusy('apply');
      try {
        // The key travels to the agent service and onto the owner's own agent.
        // It is not kept here, and this screen says so.
        await applyBrain(session, agentId, chosen);
        saveFiddySetup({
          brain:
            chosen.kind === 'preset' ? (chosen.presetId as BrainId) : 'custom',
          brainModel: chosen.model ?? null,
          brainServiceUrl:
            chosen.kind === 'custom' ? (chosen.baseUrl ?? null) : null,
        });
        const agent = agents?.find((item) => item.id === agentId);
        setNotice(
          `Done — ${agent?.name ?? 'your agent'} now thinks with ${
            chosen.kind === 'preset'
              ? brainCard(chosen.presetId as BrainId).title
              : 'your own service'
          }.`,
        );
        setKey('');
        setOpenId(null);
      } catch (caught) {
        setError(plainWords(caught));
      } finally {
        setBusy(null);
      }
      return;
    }
    saveFiddySetup({
      brain: chosen.kind === 'preset' ? (chosen.presetId as BrainId) : 'custom',
      brainModel: chosen.model ?? null,
      brainServiceUrl:
        chosen.kind === 'custom' ? (chosen.baseUrl ?? null) : null,
    });
    setNotice('Saved on this device.');
    setKey('');
    setOpenId(null);
  };

  return (
    <div className="fiddy-brains" data-fiddy="brains">
      <ul className="fiddy-card-list">
        {BRAIN_CARDS.map((brain) => {
          const selected = setup.brain === brain.id;
          return (
            <li key={brain.id}>
              <button
                type="button"
                className={`fiddy-brain-card${
                  selected ? ' fiddy-brain-card-selected' : ''
                }`}
                aria-pressed={selected}
                data-fiddy-brain={brain.id}
                data-fiddy-needs={brain.needs}
                data-state={selected ? 'selected' : 'idle'}
                onClick={() => choose(brain.id)}
              >
                <span className="fiddy-card-head">
                  <span className="fiddy-card-title">{brain.title}</span>
                  <span
                    className={`fiddy-tag fiddy-tag-${brain.tagKind}`}
                    data-fiddy-tag={brain.tagKind}
                  >
                    {brain.tag}
                  </span>
                </span>
                <span className="fiddy-card-line">{brain.line}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {card ? (
        <div className="fiddy-connect" data-fiddy="brain-connect">
          <h3 className="fiddy-connect-title">
            {card.id === 'surp'
              ? SURP_LINES.heading
              : card.needs === 'address'
                ? 'Tell Fiddy about your service.'
                : `Use your own ${card.title}.`}
          </h3>

          {card.id === 'surp' ? (
            <p className="fiddy-connect-sub">{SURP_LINES.sub}</p>
          ) : card.where ? (
            <p className="fiddy-connect-sub">
              It connects to {card.where}. Your key goes straight to your own
              agent — Fiddy keeps no copy of it.
            </p>
          ) : (
            <p className="fiddy-connect-sub">
              Your key goes straight to your own agent — Fiddy keeps no copy of
              it.
            </p>
          )}

          {card.id === 'surp' ? <SurpBrainPanel onKey={keepKey} /> : null}

          {card.needs === 'address' ? (
            <label className="fiddy-field">
              <span className="fiddy-field-label">Its address</span>
              <input
                className="fiddy-input"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://api.example.com/v1"
                data-fiddy-field="brain-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
            </label>
          ) : null}

          <label className="fiddy-field">
            <span className="fiddy-field-label">The key it gave you</span>
            <input
              className="fiddy-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="paste it here"
              data-fiddy-field="brain-key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>

          <label className="fiddy-field">
            <span className="fiddy-field-label">Which model?</span>
            <input
              className="fiddy-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              list="fiddy-brain-models"
              placeholder="the name your service uses"
              data-fiddy-field="brain-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <datalist id="fiddy-brain-models">
            {models.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>

          <div className="fiddy-connect-actions">
            <button
              type="button"
              className="fiddy-secondary-btn"
              data-fiddy-action="test-brain"
              onClick={() => void test()}
              disabled={busy !== null}
            >
              {busy === 'probe' ? 'Asking your service…' : 'Test connection'}
            </button>

            {paired && agents && agents.length > 0 ? (
              <label className="fiddy-field fiddy-field-inline">
                <span className="fiddy-field-label">Whose brain?</span>
                <select
                  className="fiddy-input"
                  data-fiddy-field="brain-agent"
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <button
              type="button"
              className="fiddy-quiet-btn fiddy-quiet-btn-outline"
              data-fiddy-action="use-brain"
              onClick={() => void use()}
              disabled={busy !== null}
            >
              {busy === 'apply'
                ? 'Changing it…'
                : paired && agentId
                  ? 'Use this brain'
                  : 'Save this choice'}
            </button>
          </div>

          {notice ? (
            <p
              role="status"
              aria-live="polite"
              className="fiddy-honest-note"
              data-fiddy="brain-notice"
            >
              <span>{notice}</span>
            </p>
          ) : null}

          {models.length > 0 ? (
            <div className="fiddy-brain-models" data-fiddy="brain-models">
              <span className="fiddy-field-label">Pick one of these:</span>
              <ul className="fiddy-brain-model-list">
                {models.slice(0, 12).map((id) => (
                  <li key={id}>
                    <button
                      type="button"
                      className="fiddy-quiet-btn fiddy-quiet-btn-inline"
                      data-fiddy-model={id}
                      onClick={() => setModel(id)}
                    >
                      {id}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="fiddy-honest-note">
            <span>
              {card.id === 'surp'
                ? paired && agentId
                  ? SURP_LINES.keptWhenApplied
                  : SURP_LINES.keptHere
                : paired && agentId
                  ? 'Your key is used to set this up on your own agent and is not kept anywhere else.'
                  : 'Saved on this device. Fiddy keeps no copy of your key, so you will paste it once more when your agent is set up.'}
            </span>
          </p>

          {error ? (
            <p role="alert" className="fiddy-alert" data-fiddy="brain-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {notice && !card ? (
        <p
          role="status"
          aria-live="polite"
          className="fiddy-honest-note"
          data-fiddy="brain-notice"
        >
          <span>{notice}</span>
        </p>
      ) : null}

      <div className="fiddy-advanced">
        <button
          type="button"
          className="fiddy-advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          Advanced — for builders
          <span aria-hidden="true">{advancedOpen ? '−' : '+'}</span>
        </button>

        {advancedOpen ? (
          <div className="fiddy-advanced-body" data-fiddy="brain-advanced">
            <label className="fiddy-field">
              <span className="fiddy-field-label">
                Connect a tool server (for builders)
              </span>
              <input
                className="fiddy-input"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://tools.example.com"
                value={toolServer}
                onChange={(event) => {
                  setToolServer(event.target.value);
                  setToolServerSaved(false);
                }}
              />
            </label>
            <button
              type="button"
              className="fiddy-quiet-btn fiddy-quiet-btn-outline"
              onClick={() => {
                saveFiddySetup({ toolServerUrl: toolServer.trim() || null });
                setToolServerSaved(true);
              }}
            >
              Save this address
            </button>
            <p className="fiddy-honest-note">
              <span>
                Not wired yet. Fiddy saves the address on this device and will
                use it when tool servers land.
              </span>
            </p>
            {toolServerSaved ? (
              <p role="status" aria-live="polite" className="fiddy-honest-note">
                <span>Saved on this device.</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

BrainSheet.displayName = 'BrainSheet';
