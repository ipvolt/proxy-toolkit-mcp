import { readFileSync } from 'node:fs';
const metadata = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string};
if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('Invalid package version');
export const VERSION = metadata.version;
export const SERVER_NAME = 'ipvolt-proxy-toolkit';
export const PUBLIC_MCP_URL = 'https://mcp.ipvolt.com/mcp';
