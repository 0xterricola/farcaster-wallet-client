/**
 * The settings section for "tell my phone": one switch, honest sentences.
 *
 * LOADED LAZILY, on purpose: this section carries the browser's alert
 * machinery, which nobody needs on the way into the app. The entry chunk is
 * measured before and after every change here (see the release notes for this
 * slice), so a switch that quietly doubles the first download is a failure
 * caught at the gate, not at a reader's phone bill.
 *
 * COPY RULES (the card's own): "When someone replies to you" — never push,
 * subscription, endpoint, VAPID, service worker. iOS needs Add to Home Screen
 * first, said in one sentence instead of a switch that fails in silence. A
 * host that never set itself up shows the reason, never a dead toggle.
 */

import { memo, useCallback, useEffect, useState } from 'react';

import { Instructions } from '~/components/forms/Instructions';
import { Toggle } from '~/components/forms/Toggle';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import {
  ALERT_KINDS,
  type AlertKinds,
  assessPhone,
  fetchAlertsCapability,
  phoneAlertsOn,
  turnOffPhoneAlerts,
  turnOnPhoneAlerts,
} from '~/snapchain/alerts/phoneAlerts';
import { loadAppKey } from '~/snapchain/appKeyStorage';
import { trackError } from '~/utils/errorUtils';

const KIND_COPY: Record<string, string> = {
  mentions: 'When someone mentions you',
  replies: 'When someone replies to you',
  likes: 'When someone likes your cast',
  follows: 'When someone follows you',
};

const PhoneAlertsSetting = memo(() => {
  const { fid } = useCurrentUser();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sentence, setSentence] = useState<string | undefined>(undefined);
  const [kinds, setKinds] = useState<AlertKinds>({
    mentions: true,
    replies: true,
    likes: true,
    follows: true,
  });

  useEffect(() => {
    let cancelled = false;
    const assess = async () => {
      const isOn = await phoneAlertsOn();
      const [capability, appKeyHex] = await Promise.all([
        fetchAlertsCapability(),
        fid === undefined ? Promise.resolve(null) : loadAppKey(fid),
      ]);
      if (cancelled) {
        return;
      }
      setOn(isOn);
      if (!isOn) {
        const state = await assessPhone(capability, {
          hasAppKey: appKeyHex !== null,
          permission:
            typeof Notification === 'undefined'
              ? 'default'
              : Notification.permission,
        });
        setSentence('ok' in state ? undefined : state.sentence);
      }
    };
    void assess();
    return () => {
      cancelled = true;
    };
  }, [fid]);

  const flip = useCallback(
    async (next: boolean) => {
      if (busy || fid === undefined) {
        return;
      }
      setBusy(true);
      try {
        const result = next
          ? await turnOnPhoneAlerts({
              fid,
              kinds,
              // English only for now, and the section says so rather than
              // promising a language the host does not write its lines in.
              language: 'en',
            })
          : await turnOffPhoneAlerts({ fid });
        setOn(result.ok);
        setSentence(result.ok ? undefined : result.sentence);
      } catch (error) {
        trackError(error);
        setSentence('Fiddy could not do that just now. Try again in a minute.');
      } finally {
        setBusy(false);
      }
    },
    [busy, fid, kinds],
  );

  const flipKind = useCallback((kind: keyof AlertKinds) => {
    setKinds((previous) => ({ ...previous, [kind]: !previous[kind] }));
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <Toggle
        label="Tell my phone"
        description={
          sentence ??
          'When someone replies to you, mentions you, likes your cast, or follows you.'
        }
        value={on}
        onValueChange={flip}
        disabled={busy}
      />
      {on ? (
        <div className="flex flex-col gap-2">
          {ALERT_KINDS.map((kind) => (
            <Toggle
              key={kind}
              label={KIND_COPY[kind]}
              description={' '}
              value={kinds[kind]}
              onValueChange={() => {
                flipKind(kind);
              }}
            />
          ))}
          <Instructions>
            Changes to these take hold the next time you turn the switch off and
            on.
          </Instructions>
        </div>
      ) : null}
      <Instructions>
        People you hide cannot reach your phone. Hidden words stay on this
        device and never leave it.
      </Instructions>
    </div>
  );
});

PhoneAlertsSetting.displayName = 'PhoneAlertsSetting';

export { PhoneAlertsSetting };
