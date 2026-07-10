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
  links: {
    keyStoreOwner: {
      forward: { on: 'keyStore', has: 'one', label: 'owner' },
      reverse: { on: '$users', has: 'many', label: 'keyStore' },
    },
    entriesOwner: {
      forward: { on: 'entries', has: 'one', label: 'owner' },
      reverse: { on: '$users', has: 'many', label: 'entries' },
    },
    // onDelete: 'cascade' on the "one" side (entryHistory -> its one entry)
    // means deleting an entries row cascades to delete its entryHistory rows,
    // so permanentlyDeleteUserEntry doesn't need to delete them separately.
    entryHistoryEntry: {
      forward: { on: 'entryHistory', has: 'one', label: 'entry', onDelete: 'cascade' },
      reverse: { on: 'entries', has: 'many', label: 'history' },
    },
  },
});

// This idiom (re-exporting the inferred type via an empty interface) is
// InstantDB's own convention for schema files, see the CLI-generated
// boilerplate at https://instantdb.com/docs/modeling-data.
type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
