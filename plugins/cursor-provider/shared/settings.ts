import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const cursorSettings = defineSettings({
  id: "cursor-sdk",
  scope: "host",
  version: 1,
  schema: z
    .object({
      apiKey: z.string().min(1).optional(),
    })
    .strict(),
});
