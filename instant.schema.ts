import { i } from '@instantdb/react';

// Pulled from the live app (npx instant-cli@latest pull schema) rather than
// hand-maintained: this file drifting from what's actually live caused
// several real bugs earlier (see docs/data_model.md, Uniqueness), so the
// live schema is treated as the source of truth going forward. $files holds
// each entry's current data and its entire history in one linked file now
// (see entryFileEntry below), no longer just a schema internal;
// $usersLinkedPrimaryUser is still an InstantDB system link this app never
// touches directly, kept because the query validator needs local schema for
// anything a dot-notation where filter traverses into, same reason $users
// itself must be declared explicitly.
//
// umkStoreOwner is has: 'one' on both sides (one UMK row per user). A
// genuine has:'one'/has:'one' shape on this exact link produced a
// persistent "already exists" uniqueness rejection once before, even after
// confirming zero existing rows, no leftover entities from diagnostic
// renames, and correct auth (see docs/data_model.md, Uniqueness) -- this is
// a deliberate retry of that same shape, not a first attempt. Under a
// genuine has:'one' constraint there's no "more than one row" case left to
// check client side (queryOwnUmkStoreRow in src/db.ts gets a single row or
// undefined back, not an array), so the schema constraint is what's actually
// being trusted this time. If the "already exists" rejection recurs, the
// known fallback is has: 'many' on the `$users` side plus a client-side
// "more than one row is fatal" check, same pattern as before. entryFileEntry
// below is has: 'one' on both sides too, for an unrelated reason (its swap
// is a single atomic db.transact, see its own comment).

const _schema = i.schema({
  entities: {
    $files: i.entity({
      path: i.string().unique().indexed(),
      url: i.string().optional(),
    }),
    $users: i.entity({
      email: i.string().unique().indexed().optional(),
      imageURL: i.string().optional(),
      type: i.string().optional(),
    }),
    entries: i.entity({
      entryKeyBlob: i.string(),
    }),
    umkStore: i.entity({
      umkBlob: i.string(),
    }),
  },
  links: {
    $usersLinkedPrimaryUser: {
      forward: {
        on: '$users',
        has: 'one',
        label: 'linkedPrimaryUser',
        onDelete: 'cascade',
      },
      reverse: {
        on: '$users',
        has: 'many',
        label: 'linkedGuestUsers',
      },
    },
    // entries no longer links to $users directly: ownership is transitive,
    // through the entry's own umkStore row -- auth.id in
    // data.ref('umk.owner.id') in instant.perms.ts, not a direct
    // data.ref('owner.id'). One fewer link targeting $users, which is where
    // the "connects to non existing entity" push bug above always hit.
    entriesUmkStore: {
      forward: {
        on: 'entries',
        has: 'one',
        label: 'umk',
        required: true,
        onDelete: 'cascade',
      },
      reverse: {
        on: 'umkStore',
        has: 'many',
        label: 'entries',
      },
    },
    // No required: true here, unlike entriesUmkStore above: the $files row is
    // created by a separate db.storage.uploadFile call before the
    // db.transact that links it (see docs/crypto.md, Entry Data File), so
    // for a moment after upload the file exists unlinked; required would
    // reject that transient state. has: 'one' on both sides is safe despite
    // that, since the eventual link (and unlink of the old file) happens in
    // one atomic db.transact, so there's never an externally observable
    // moment with zero or two files linked to an entry.
    entryFileEntry: {
      forward: {
        on: '$files',
        has: 'one',
        label: 'entry',
        onDelete: 'cascade',
      },
      reverse: {
        on: 'entries',
        has: 'one',
        label: 'entryFile',
      },
    },
    // required: true is deliberately absent here, unlike entriesUmkStore
    // above: the dashboard recreation of this link (see the comment
    // above) did not set it, and this file mirrors what is actually live,
    // not what would ideally be set. ensureKeyStore always provides owner
    // when creating a umkStore row regardless, so this has no functional
    // effect today; set "Require this attribute" in the dashboard and add
    // it back here if closing that gap ever matters.
    umkStoreOwner: {
      forward: {
        on: 'umkStore',
        has: 'one',
        label: 'owner',
        onDelete: 'cascade',
      },
      reverse: {
        on: '$users',
        has: 'one',
        label: 'umkStore',
      },
    },
  },
  rooms: {},
});

// This idiom (re-exporting the inferred type via an empty interface) is
// InstantDB's own convention for schema files, see the CLI-generated
// boilerplate at https://instantdb.com/docs/modeling-data.
type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
