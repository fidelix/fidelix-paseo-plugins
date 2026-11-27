import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const validateCursorKeyRpc = defineRpc({
  name: "cursor.validate-key",
  input: z
    .object({
      apiKey: z.string().min(1).optional(),
    })
    .strict(),
  output: z
    .object({
      ok: z.boolean(),
      message: z.string(),
    })
    .strict(),
});

export const startCursorLoginRpc = defineRpc({
  name: "cursor.login-start",
  input: z.object({}).strict(),
  output: z
    .object({
      ok: z.boolean(),
      loginUrl: z.string().optional(),
      message: z.string(),
    })
    .strict(),
});

export const cursorLoginStatusRpc = defineRpc({
  name: "cursor.login-status",
  input: z.object({}).strict(),
  output: z
    .object({
      phase: z.enum(["idle", "waiting", "done", "expired"]),
      loginUrl: z.string().optional(),
      email: z.string().optional(),
      message: z.string(),
    })
    .strict(),
});
