import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { cursorSettings } from "../shared/settings";
import { validateCursorKeyRpc } from "../shared/validate";

export function CursorSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(cursorSettings);
  const validateKey = useRpc(validateCursorKeyRpc);
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const keyRef = useRef<string>("");

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
    }),
    [theme, layout.compact],
  );

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

  async function validate() {
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error("Paste a key first");
      return;
    }
    setChecking(true);
    try {
      const result = await validateKey({ apiKey: trimmed });
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Key check failed");
    } finally {
      setChecking(false);
    }
  }
  async function save() {
    const ok = await settings.save({ apiKey: value.trim() ? value.trim() : undefined }, revision);
    if (ok) {
      setDraft(null);
      toast.show("Cursor API key saved", { variant: "success" });
    } else {
      toast.error(settings.saveError ?? "Could not save settings");
    }
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Cursor</Text>
      <Text style={styles.body}>
        The Cursor SDK needs a user or service-account API key. CLI login does not transfer. Mint
        one at cursor.com/dashboard/api — it bills to your plan like IDE usage.
      </Text>
      <SettingsCard>
        <SettingsSection title="API key" info="Stored on this daemon host. Never leaves the machine.">
          <SettingsRow label="Status" hint={stored ? "A key is stored." : "No key stored."}>
            <Text style={stored ? styles.ok : styles.bad}>{stored ? "Configured" : "Missing"}</Text>
          </SettingsRow>
          <SettingsInput
            label="API key"
            hint="crsr_… — paste to replace the stored key"
            placeholder="crsr_…"
            secureTextEntry
            initialValue={stored}
            onChangeText={(text) => {
              keyRef.current = text;
              setDraft(text);
            }}
          />
          <SettingsAction
            label="Save"
            hint="Writes the key to host-scoped plugin settings"
            actionLabel={settings.saving ? "Saving…" : "Save key"}
            disabled={!dirty || settings.saving}
            onPress={() => void save()}
          />
          <SettingsAction
            label="Validate"
            hint="Runs a key-only catalog check without spending"
            actionLabel={checking ? "Checking…" : "Check key"}
            disabled={checking || !value.trim()}
            onPress={() => void validate()}
          />
        </SettingsSection>
      </SettingsCard>
      <ExternalLink href="https://cursor.com/dashboard/api">Open cursor.com/dashboard/api</ExternalLink>
    </View>
  );
}
