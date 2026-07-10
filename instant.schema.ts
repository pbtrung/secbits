import { i } from '@instantdb/react';

// Entities, links, and permission rules are specified in docs/data_model.md.
// Every field beyond row id and the owner/entry link is an opaque encrypted
// blob; InstantDB never sees plaintext content.

const _schema = i.schema({
  entities: {
    keyStore: i.entity({
      umkBlob: i.string(),
      backupKeyBlob: i.string(),
    }),
    entries: i.entity({
      entryKey: i.string(),
      encryptedData: i.string(),
    }),
    entryHistory: i.entity({
      encryptedSnapshot: i.string(),
    }),
  },
  // Links are created via the InstantDB dashboard UI instead of pushed here:
  // pushing new links to $users through the CLI hit an unresolved bug (see
  // docs/data_model.md). Create these three manually in the dashboard so the
  // resulting link names match what instant.perms.ts and src/db.js expect:
  //   keyStore.owner  -> one, to $users
  //   entries.owner   -> one, to $users
  //   entryHistory.entry -> one, to entries, onDelete: cascade
  links: {},
});

// This idiom (re-exporting the inferred type via an empty interface) is
// InstantDB's own convention for schema files, see the CLI-generated
// boilerplate at https://instantdb.com/docs/modeling-data.
type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
