// Cloudflare Pages Function: /api/drive/* → the Google Drive token broker.
// All logic lives in server/drive/broker.ts (unit-tested there); this file only
// adapts the Pages context. See functions/README.md for configuration.
import { handleDriveRequest, type DriveEnv } from "../../../server/drive/broker";

export const onRequest = (context: { request: Request; env: DriveEnv }): Promise<Response> =>
  handleDriveRequest(context.request, context.env);
