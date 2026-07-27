import {
  createCloudflareD1Store,
  type CloudflareD1Database,
} from "@pegma/storage-cloudflare-d1";

declare const directBinding: CloudflareD1Database;
declare const session: Omit<CloudflareD1Database, "withSession">;

createCloudflareD1Store({ database: directBinding });

// A session must not be accepted accidentally: it may read from replicas.
// @ts-expect-error A D1 session has no withSession discriminator.
createCloudflareD1Store({ database: session });
