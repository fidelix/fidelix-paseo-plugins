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
import { Pressable, Text, View } from "react-native";
import { cursorSettings } from "../shared/settings";
import { cursorLoginStatusRpc, startCursorLoginRpc, validateCursorKeyRpc } from "../shared/validate";

type LoginPhase = "idle" | "waiting" | "done" | "expired";

export function CursorSettingsScreen({ theme, layout }: PluginSurfaceProps) {
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
  const [loginHint, setLoginHint] = useState("Sign in with your Cursor account — no key to paste.");
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadline = useRef(0);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
      body: { color: theme.colors.foregroundMuted },
      ok: { color: theme.colors.statusSuccess },
      bad: { color: theme.colors.statusDanger },
      linkBox: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        gap: 8,
      },
      linkText: { color: theme.colors.accent, fontSize: 13 },
      copyHint: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  // Stop polling when the screen unmounts.
  useEffect(
    () => () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    },
    [],
  );

  async function pollOnce(): Promise<boolean> {
    try {
      const state = await loginStatus({});
      if (state.phase === "done") {
        setLoginPhase("done");
        setLoginEmail(state.email ?? null);
        setLoginHint(state.message);
        toast.show("Signed in with Cursor", { variant: "success" });
        return true;
      }
      if (state.phase === "expired") {
        setLoginPhase("expired");
        setLoginHint(state.message);
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
      setLoginHint("Open the link, sign in with Cursor, then come back here.");
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
      const ok = await settings.save(
        { apiKey: trimmed ? trimmed : undefined },
        revision,
      );
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
    return (
      <View style={styles.screen}>
        <Text style={styles.body}>Loading Cursor settings…</Text>
      </View>
    );
  }
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <View style={styles.screen}>
        <Text style={styles.bad}>{settings.error}</Text>
      </View>
    );
  }

  const revision = settings.revision;
  const stored = settings.values.apiKey ?? "";
  const value = draft ?? stored;
  const dirty = value !== stored;
  const busy = checking || saving || settings.saving;

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Cursor</Text>
      <Text style={styles.body}>
        Sign in with your Cursor account, or paste a user/service-account API key. CLI login does
        not transfer. Keys bill to your plan like IDE usage.
      </Text>

      <SettingsCard>
        <SettingsSection title="Sign in" info="Recommended — mints a 90-day key automatically.">
          {loginPhase === "waiting" && loginUrl ? (
            <View style={styles.linkBox}>
              <Text style={styles.body}>{loginHint}</Text>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="Open Cursor sign-in link"
                onPress={() => void openExternalUrl(loginUrl)}
              >
                <Text style={styles.linkText} numberOfLines={2}>
                  {loginUrl}
                </Text>
              </Pressable>
              <Text style={styles.copyHint}>
                Waiting for browser sign-in… this screen checks every few seconds for 5 minutes.
              </Text>
            </View>
          ) : (
            <SettingsAction
              label="Sign in"
              hint={
                loginPhase === "done"
                  ? loginHint
                  : loginPhase === "expired"
                    ? "Previous attempt timed out — start again"
                    : "Get a sign-in link, no paste needed"
              }
              actionLabel={loginPhase === "done" ? "Signed in" : "Sign in with Cursor"}
              disabled={loginPhase === "done"}
              onPress={() => void beginLogin()}
            />
          )}
          {loginPhase === "expired" ? (
            <SettingsAction
              label="Retry"
              hint="Start the sign-in flow again"
              actionLabel="Start again"
              onPress={() => {
                setLoginPhase("idle");
                setLoginUrl(null);
                void beginLogin();
              }}
            />
          ) : null}
          {loginEmail ? (
            <SettingsRow label="Account" hint="From the completed browser sign-in">
              <Text style={styles.ok}>{loginEmail}</Text>
            </SettingsRow>
          ) : null}
        </SettingsSection>
      </SettingsCard>

      <SettingsCard>
        <SettingsSection title="API key" info="Stored on this daemon host. Never leaves the machine.">
          <SettingsRow label="Status" hint={stored ? "A key is stored." : "No key stored."}>
            <Text style={stored ? styles.ok : styles.bad}>{stored ? "Configured" : "Missing"}</Text>
          </SettingsRow>
          <SettingsInput
            label="API key"
            hint="crsr_… — checked before it is saved"
            placeholder="crsr_…"
            secureTextEntry
            initialValue={stored}
            onChangeText={(text) => setDraft(text)}
          />
          <SettingsAction
            label="Check key"
            hint="Runs a key-only catalog check without spending — always runs before save"
            actionLabel={checking ? "Checking…" : "Check and save key"}
            disabled={busy || !value.trim()}
            onPress={() => void save()}
          />
          {!dirty && stored ? (
            <Text style={styles.body}>Key is saved and was checked on save.</Text>
          ) : null}
        </SettingsSection>
      </SettingsCard>
      <ExternalLink href="https://cursor.com/dashboard/api">Open cursor.com/dashboard/api</ExternalLink>
    </View>
  );
}
