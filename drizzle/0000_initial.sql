CREATE TABLE scopes (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  create_time INTEGER NOT NULL, update_time INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE modules (
  id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL REFERENCES scopes(id),
  name TEXT NOT NULL, visibility INTEGER NOT NULL, deprecated INTEGER NOT NULL DEFAULT 0,
  default_label_name TEXT NOT NULL DEFAULT 'main', description TEXT, url TEXT,
  create_time INTEGER NOT NULL, update_time INTEGER NOT NULL, UNIQUE(scope_id, name)
) STRICT;
--> statement-breakpoint
CREATE TABLE commits (
  id TEXT PRIMARY KEY NOT NULL, module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  digest_type INTEGER NOT NULL, digest_value TEXT NOT NULL, source_control_url TEXT,
  created_by_user_id TEXT, create_time INTEGER NOT NULL, UNIQUE(module_id, digest_value)
) STRICT;
--> statement-breakpoint
CREATE TABLE labels (
  id TEXT PRIMARY KEY NOT NULL, module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL, commit_id TEXT NOT NULL REFERENCES commits(id), archive_time INTEGER,
  updated_by_user_id TEXT, create_time INTEGER NOT NULL, update_time INTEGER NOT NULL,
  UNIQUE(module_id, name)
) STRICT;
--> statement-breakpoint
CREATE TABLE label_events (
  id TEXT PRIMARY KEY NOT NULL, label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  commit_id TEXT NOT NULL REFERENCES commits(id), action TEXT NOT NULL, user_id TEXT,
  create_time INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE commit_dependencies (
  commit_id TEXT NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  dep_commit_id TEXT NOT NULL REFERENCES commits(id) DEFERRABLE INITIALLY DEFERRED,
  dep_registry TEXT NOT NULL, dep_owner TEXT NOT NULL, dep_module TEXT NOT NULL, dep_digest TEXT,
  PRIMARY KEY(commit_id, dep_commit_id)
) STRICT;
--> statement-breakpoint
CREATE INDEX commit_dependencies_target ON commit_dependencies(dep_commit_id);
--> statement-breakpoint
CREATE INDEX label_events_history ON label_events(label_id, create_time);
