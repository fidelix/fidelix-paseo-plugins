// Local JsonValue stand-in. @getpaseo/protocol/agent-types is not in the
// plugin compiler's host-module allowlist (only @getpaseo/plugin* + zod are
// external), so importing it fails Git-source installs where node_modules
// holds only production deps. This structural equivalent keeps typechecking
// without the extra package.
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
