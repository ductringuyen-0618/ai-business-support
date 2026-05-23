"use client";

import { useState } from "react";

import { serializeChannelPrefsForm, type ChannelPrefsFormState } from "./serialize";

interface Props {
  initial: ChannelPrefsFormState;
  timezones: string[];
}

/**
 * Client component for the channel-preferences settings page (slice 11).
 *
 * State is held locally; saving POSTs to `/api/operator/channel-prefs` and
 * the SMS verification flow uses the two `/api/operator/verify-phone/*`
 * endpoints. Kept deliberately plain — no form library — because the surface
 * is small and the serialisation logic is exported so the unit tests can
 * exercise it without rendering React.
 */
export function ChannelPrefsForm({ initial, timezones }: Props) {
  const [state, setState] = useState<ChannelPrefsFormState>(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Phone verification UI state
  const [phoneDraft, setPhoneDraft] = useState(initial.sms.phoneE164 ?? "");
  const [codeDraft, setCodeDraft] = useState("");
  const [verifyStage, setVerifyStage] = useState<"idle" | "sent" | "verifying">("idle");
  const [verifyError, setVerifyError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = serializeChannelPrefsForm(state);
      const res = await fetch("/api/operator/channel-prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `save failed (${res.status})`);
      }
      setSavedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function startVerify() {
    setVerifyError(null);
    setVerifyStage("verifying");
    try {
      const res = await fetch("/api/operator/verify-phone/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phoneE164: phoneDraft }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "verification failed to start");
      }
      setVerifyStage("sent");
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "verification failed");
      setVerifyStage("idle");
    }
  }

  async function confirmVerify() {
    setVerifyError(null);
    try {
      const res = await fetch("/api/operator/verify-phone/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: codeDraft }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "verification failed");
      }
      const payload = (await res.json()) as { phoneE164: string };
      setState((prev) => ({
        ...prev,
        sms: { ...prev.sms, enabled: true, phoneE164: payload.phoneE164 },
      }));
      setVerifyStage("idle");
      setCodeDraft("");
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "verification failed");
    }
  }

  return (
    <form className="space-y-6" onSubmit={handleSave}>
      <ChannelCard
        title="Email"
        description="Always available; default on. Receives the LLM-drafted reply as a draft for you to post manually on Google."
        channel={state.email}
        onChange={(next) => setState((prev) => ({ ...prev, email: next }))}
        timezones={timezones}
      />

      <ChannelCard
        title="SMS"
        description="Opt-in. Sent to a verified phone number; pages you immediately outside quiet hours."
        channel={{ ...state.sms, enabled: state.sms.enabled && Boolean(state.sms.phoneE164) }}
        onChange={(next) =>
          setState((prev) => ({
            ...prev,
            sms: { ...next, phoneE164: prev.sms.phoneE164 },
          }))
        }
        timezones={timezones}
        disabled={!state.sms.phoneE164}
        disabledReason={
          state.sms.phoneE164 ? null : "Verify a phone number below before enabling SMS."
        }
      />

      <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-slate-900">Phone number</h2>
        <p className="text-xs text-slate-500">
          We send you a 6-digit code by SMS; enter it below to confirm the number is yours.
        </p>
        {state.sms.phoneE164 && verifyStage === "idle" ? (
          <p className="text-sm text-emerald-700">
            Verified: <span className="font-mono">{state.sms.phoneE164}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[200px] flex-1 flex-col text-xs text-slate-600">
            <span>Phone number (E.164, e.g. +15555550123)</span>
            <input
              type="tel"
              value={phoneDraft}
              onChange={(e) => setPhoneDraft(e.target.value)}
              className="mt-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="+15555550123"
            />
          </label>
          <button
            type="button"
            onClick={startVerify}
            disabled={verifyStage === "verifying" || !phoneDraft}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:bg-slate-300"
          >
            {verifyStage === "verifying" ? "Sending…" : "Send code"}
          </button>
        </div>
        {verifyStage === "sent" ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
            <label className="flex flex-col text-xs text-slate-600">
              <span>6-digit code</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={codeDraft}
                onChange={(e) => setCodeDraft(e.target.value)}
                className="mt-1 w-32 rounded border border-slate-300 px-2 py-1.5 font-mono text-sm"
              />
            </label>
            <button
              type="button"
              onClick={confirmVerify}
              disabled={codeDraft.length !== 6}
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white disabled:bg-slate-300"
            >
              Verify code
            </button>
          </div>
        ) : null}
        {verifyError ? <p className="text-sm text-red-600">{verifyError}</p> : null}
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {savedAt && !error ? (
        <p className="text-sm text-emerald-700">Saved {savedAt.toLocaleTimeString()}.</p>
      ) : null}

      <button
        type="submit"
        disabled={saving}
        className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:bg-slate-300"
      >
        {saving ? "Saving…" : "Save preferences"}
      </button>
    </form>
  );
}

interface ChannelCardProps {
  title: string;
  description: string;
  channel: ChannelPrefsFormState["email"];
  onChange: (next: ChannelPrefsFormState["email"]) => void;
  timezones: string[];
  disabled?: boolean;
  disabledReason?: string | null;
}

function ChannelCard({
  title,
  description,
  channel,
  onChange,
  timezones,
  disabled = false,
  disabledReason = null,
}: ChannelCardProps) {
  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-xs text-slate-500">{description}</p>
          {disabled && disabledReason ? (
            <p className="mt-1 text-xs text-amber-700">{disabledReason}</p>
          ) : null}
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={channel.enabled}
            disabled={disabled}
            onChange={(e) => onChange({ ...channel, enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col text-xs text-slate-600">
          <span>Quiet hours start</span>
          <input
            type="time"
            value={channel.quietHoursStart ?? ""}
            onChange={(e) => onChange({ ...channel, quietHoursStart: e.target.value || null })}
            className="mt-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs text-slate-600">
          <span>Quiet hours end</span>
          <input
            type="time"
            value={channel.quietHoursEnd ?? ""}
            onChange={(e) => onChange({ ...channel, quietHoursEnd: e.target.value || null })}
            className="mt-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs text-slate-600">
          <span>Timezone</span>
          <select
            value={channel.timezone}
            onChange={(e) => onChange({ ...channel, timezone: e.target.value })}
            className="mt-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
