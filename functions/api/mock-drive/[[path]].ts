// Cloudflare Pages Function: /api/mock-drive/* → a fake Google Drive for local
// development and end-to-end tests. Answers ONLY when DRIVE_MODE=mock, so a
// production deploy (DRIVE_MODE=google) serves nothing here.
import { handleMockDrive } from "../../../server/drive/mockDrive";
import type { DriveEnv } from "../../../server/drive/broker";

export const onRequest = (context: { request: Request; env: DriveEnv }): Promise<Response> => {
  if (context.env.DRIVE_MODE !== "mock" || !context.env.DRIVE_KV) {
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }
  return handleMockDrive(context.request, context.env.DRIVE_KV);
};
