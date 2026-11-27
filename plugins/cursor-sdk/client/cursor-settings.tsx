import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { cursorSettings } from "../shared/settings";
import { cursorLoginStatusRpc, startCursorLoginRpc, validateCursorKeyRpc } from "../shared/validate";

type LoginPhase = "idle" | "waiting" | "done" | "expired";

export function CursorSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(cursorSettings);
  const validateKey = useRpc(validateCursorKeyRpc);
  const startLogin = useRpc(startCursorLoginRpc);
  const loginStatus = useRpc(cursorLoginStatusRpc);
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loginPhase, setLoginPhase] = useState<LoginPhase>("idle");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadline = useRef(0);

  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted, fontSize: 14 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
      ok: { color: theme.colors.statusSuccess, fontSize: 14 },
    }),
    [theme],
  );

  useEffect(() => {
    let cancelled = false;
    loginStatus({})
      .then((state) => {
        if (cancelled || state.phase !== "done") return;
        setLoginPhase("done");
        setLoginEmail(state.email ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  async function pollOnce(): Promise<boolean> {
    try {
      const state = await loginStatus({});
      if (state.phase === "done") {
        setLoginPhase("done");
        setLoginEmail(state.email ?? null);
        toast.show("Signed in with Cursor", { variant: "success" });
        return true;
      }
      if (state.phase === "expired") {
        setLoginPhase("expired");
        return true;
      }
      if (state.phase === "waiting" && state.loginUrl && state.loginUrl !== loginUrl) {
        setLoginUrl(state.loginUrl);
      }
      return false;
    } catch {
      // Transient RPC failure: keep polling until the deadline.
      return false;
    }
  }

  function schedulePoll() {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(async () => {
      pollTimer.current = null;
      if (Date.now() >= pollDeadline.current) {
        // One last status read so an expiry already recorded daemon-side
        // surfaces instead of a client-side timeout message.
        await pollOnce();
        setLoginPhase((phase) => (phase === "waiting" ? "expired" : phase));
        return;
      }
      const settled = await pollOnce();
      if (!settled) schedulePoll();
    }, 5000);
  }

  async function beginLogin() {
    try {
      const result = await startLogin({});
      if (!result.ok || !result.loginUrl) {
        toast.error(result.message);
        return;
      }
      setLoginUrl(result.loginUrl);
      setLoginPhase("waiting");
      void openExternalUrl(result.loginUrl);
      // 5-minute window, matching the daemon poll deadline; the flow simply
      // restarts from this screen afterwards (no auto-retry).
      pollDeadline.current = Date.now() + 5 * 60 * 1000;
      schedulePoll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start sign-in");
    }
  }

  // Save always validates first: a key that fails the check is never stored.
  async function save() {
    if (settings.status !== "ready") return;
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error("Paste a key first");
      return;
    }
    setChecking(true);
    try {
      const result = await validateKey({ apiKey: trimmed });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Key check failed");
      return;
    } finally {
      setChecking(false);
    }
    setSaving(true);
    try {
      const ok = await settings.save({ apiKey: trimmed }, revision);
      if (ok) {
        setDraft(null);
        toast.show("Cursor API key saved", { variant: "success" });
      } else {
        toast.error(settings.saveError ?? "Could not save settings");
      }
    } finally {
      setSaving(false);
    }
  }

  if (settings.status === "loading") {
    return <Text style={styles.muted}>Loading Cursor settings…</Text>;
  }
  if (settings.status === "error" || settings.status === "invalid") {
    return <Text style={styles.error}>{settings.error}</Text>;
  }

  const revision = settings.revision;
  const stored = settings.values.apiKey ?? "";
  const value = draft ?? stored;
  const dirty = value !== stored;
  const busy = checking || saving || settings.saving;

  const connection = stored
    ? { text: "API key", hint: "Agents use the key saved below.", style: styles.ok }
    : loginPhase === "done"
      ? {
          text: "Signed in",
          hint: loginEmail ? `Signed in as ${loginEmail}.` : "Signed in with your Cursor account.",
          style: styles.ok,
        }
      : {
          text: "Not set",
          hint: "Sign in or save a key. CURSOR_API_KEY on the daemon also works.",
          style: styles.muted,
        };

  return (
    <View>
      <SettingsSection title="Connection" info="Usage bills to your Cursor plan, as it does in the Cursor editor. Signing in to the Cursor CLI does not carry over.">
        <SettingsCard>
          <SettingsRow label="Status" hint={connection.hint}>
            <Text style={connection.style}>{connection.text}</Text>
          </SettingsRow>
          {loginPhase === "waiting" && loginUrl ? (
            <SettingsAction
              label="Finish in your browser"
              hint="This screen checks every few seconds for 5 minutes."
              actionLabel="Open link"
              onPress={() => void openExternalUrl(loginUrl)}
            />
          ) : (
            <SettingsAction
              label="Cursor account"
              hint={
                loginPhase === "expired"
                  ? "The last sign-in timed out. Start again."
                  : "Creates a key named Paseo in your account. Nothing to paste."
              }
              actionLabel={loginPhase === "done" ? "Signed in" : "Sign in with Cursor"}
              disabled={loginPhase === "done"}
              onPress={() => void beginLogin()}
            />
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="API key" info="Saved in this plugin's settings on the Paseo host. A saved key takes priority over a sign-in.">
        <SettingsCard>
          <SettingsInput
            label="Key"
            hint="A user or service-account key, starting with crsr_."
            placeholder="crsr_…"
            secureTextEntry
            initialValue={stored}
            onChangeText={(text) => setDraft(text)}
          />
          <SettingsAction
            label="Save key"
            hint={
              !dirty && stored
                ? "Saved and checked."
                : "Checked with Cursor before saving. The check uses no credits."
            }
            actionLabel={checking ? "Checking…" : saving ? "Saving…" : "Check and save"}
            disabled={busy || !value.trim()}
            onPress={() => void save()}
          />
          <SettingsRow label="Get a key" hint="Create one in the Cursor dashboard.">
            <ExternalLink href="https://cursor.com/dashboard/api">cursor.com/dashboard/api</ExternalLink>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
