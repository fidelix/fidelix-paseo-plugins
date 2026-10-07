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
