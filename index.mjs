// klypix-mcp — programmatic entry. Re-exports the pure .klypix format library
// (parse / build / append / markdown / atomic write) so you can read and write
// the agent-neutral canvas file from any Node code, with no MCP/agent in the
// loop. The MCP server itself is the `klypix-mcp` bin.
export * from './src/klypix-format.mjs';
