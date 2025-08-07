#!/usr/bin/env node

/**
 * Migration script to convert from auto-increment IDs to tweet_id as primary key
 * 
 * WARNING: This script will modify your database structure. 
 * Make sure to backup your database before running this migration!
 * 
 * Usage: node migrate-to-tweet-id.js
 */

import { getDatabase } from './db.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class DatabaseMigration {
  constructor() {
    this.db = getDatabase();
  }

  async migrate() {
    console.log('🚀 Starting migration to tweet_id as primary key...\n');

    try {
      // 1. Create backup
      await this.createBackup();

      // 2. Check if migration is needed
      const needsMigration = await this.checkIfMigrationNeeded();
      if (!needsMigration) {
        console.log('✅ Database is already using tweet_id as primary key. No migration needed.');
        return;
      }

      // 3. Enable foreign keys temporarily
      await this.db.run('PRAGMA foreign_keys = OFF');

      // 4. Migrate tables step by step
      await this.migrateTwitterUrlsTable();
      await this.migrateTweetContentTable();
      await this.migrateMediaFilesTable();
      await this.migrateAISummariesTable();
      await this.migrateCompilationItemsTable();

      // 5. Re-enable foreign keys
      await this.db.run('PRAGMA foreign_keys = ON');

      // 6. Verify migration
      await this.verifyMigration();

      console.log('\n✅ Migration completed successfully!');
      console.log('📝 Your database now uses tweet_id as the primary identifier.');
      
    } catch (error) {
      console.error('\n❌ Migration failed:', error.message);
      console.log('💾 You can restore from the backup if needed.');
      throw error;
    }
  }

  async createBackup() {
    const dbPath = path.join(__dirname, '../data/db.sqlite');
    const backupPath = path.join(__dirname, '../data/db_backup_' + Date.now() + '.sqlite');
    
    if (await fs.pathExists(dbPath)) {
      await fs.copy(dbPath, backupPath);
      console.log(`💾 Backup created: ${backupPath}`);
    }
  }

  async checkIfMigrationNeeded() {
    try {
      // Check if the old structure exists (auto-increment id in twitter_urls)
      const result = await this.db.get(`
        SELECT sql FROM sqlite_master 
        WHERE type='table' AND name='twitter_urls'
      `);
      
      return result && result.sql.includes('id INTEGER PRIMARY KEY AUTOINCREMENT');
    } catch (error) {
      return false;
    }
  }

  async migrateTwitterUrlsTable() {
    console.log('📝 Migrating twitter_urls table...');

    // Create new table
    await this.db.run(`
      CREATE TABLE twitter_urls_new (
        tweet_id TEXT PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        author_username TEXT,
        author_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed BOOLEAN DEFAULT FALSE,
        last_processed DATETIME,
        status TEXT DEFAULT 'pending'
      )
    `);

    // Copy data, filtering out rows without tweet_id
    await this.db.run(`
      INSERT INTO twitter_urls_new (tweet_id, url, author_username, author_name, created_at, processed, last_processed, status)
      SELECT tweet_id, url, author_username, author_name, created_at, processed, last_processed, status
      FROM twitter_urls 
      WHERE tweet_id IS NOT NULL AND tweet_id != ''
    `);

    // Drop old table and rename new one
    await this.db.run('DROP TABLE twitter_urls');
    await this.db.run('ALTER TABLE twitter_urls_new RENAME TO twitter_urls');

    console.log('✅ twitter_urls table migrated');
  }

  async migrateTweetContentTable() {
    console.log('📝 Migrating tweet_content table...');

    // Create new table
    await this.db.run(`
      CREATE TABLE tweet_content_new (
        tweet_id TEXT PRIMARY KEY,
        author_id TEXT,
        author_username TEXT,
        author_name TEXT,
        author_profile_image TEXT,
        tweet_text TEXT,
        tweet_created_at DATETIME,
        like_count INTEGER DEFAULT 0,
        retweet_count INTEGER DEFAULT 0,
        reply_count INTEGER DEFAULT 0,
        quote_count INTEGER DEFAULT 0,
        bookmark_count INTEGER DEFAULT 0,
        impression_count INTEGER DEFAULT 0,
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tweet_id) REFERENCES twitter_urls (tweet_id) ON DELETE CASCADE
      )
    `);

    // Copy data
    await this.db.run(`
      INSERT INTO tweet_content_new (tweet_id, author_id, author_username, author_name, author_profile_image, 
                                   tweet_text, tweet_created_at, like_count, retweet_count, reply_count, 
                                   quote_count, bookmark_count, impression_count, fetched_at)
      SELECT tweet_id, author_id, author_username, author_name, author_profile_image, 
             tweet_text, created_at, like_count, retweet_count, reply_count, 
             quote_count, bookmark_count, impression_count, fetched_at
      FROM tweet_content 
      WHERE tweet_id IS NOT NULL AND tweet_id != ''
    `);

    // Drop old table and rename new one
    await this.db.run('DROP TABLE tweet_content');
    await this.db.run('ALTER TABLE tweet_content_new RENAME TO tweet_content');

    console.log('✅ tweet_content table migrated');
  }

  async migrateMediaFilesTable() {
    console.log('📝 Migrating media_files table...');

    // Create new table
    await this.db.run(`
      CREATE TABLE media_files_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id TEXT NOT NULL,
        media_key TEXT,
        media_type TEXT NOT NULL,
        media_url TEXT,
        local_path TEXT,
        width INTEGER,
        height INTEGER,
        duration_ms INTEGER,
        file_size INTEGER,
        downloaded BOOLEAN DEFAULT FALSE,
        download_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tweet_id) REFERENCES tweet_content (tweet_id) ON DELETE CASCADE
      )
    `);

    // Copy data by joining with tweet_content to get tweet_id
    await this.db.run(`
      INSERT INTO media_files_new (id, tweet_id, media_key, media_type, media_url, local_path, 
                                 width, height, duration_ms, file_size, downloaded, download_error, created_at)
      SELECT mf.id, tc.tweet_id, mf.media_key, mf.media_type, mf.media_url, mf.local_path, 
             mf.width, mf.height, mf.duration_ms, mf.file_size, mf.downloaded, mf.download_error, mf.created_at
      FROM media_files mf
      JOIN tweet_content tc ON mf.tweet_content_id = tc.id
      WHERE tc.tweet_id IS NOT NULL
    `);

    // Drop old table and rename new one
    await this.db.run('DROP TABLE media_files');
    await this.db.run('ALTER TABLE media_files_new RENAME TO media_files');

    console.log('✅ media_files table migrated');
  }

  async migrateAISummariesTable() {
    console.log('📝 Migrating ai_summaries table...');

    // Create new table
    await this.db.run(`
      CREATE TABLE ai_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id TEXT NOT NULL,
        summary_text TEXT,
        summary_type TEXT DEFAULT 'gemini',
        tokens_used INTEGER,
        processing_time_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tweet_id) REFERENCES tweet_content (tweet_id) ON DELETE CASCADE
      )
    `);

    // Copy data by joining with tweet_content to get tweet_id
    await this.db.run(`
      INSERT INTO ai_summaries_new (id, tweet_id, summary_text, summary_type, tokens_used, processing_time_ms, created_at)
      SELECT ais.id, tc.tweet_id, ais.summary_text, ais.summary_type, ais.tokens_used, ais.processing_time_ms, ais.created_at
      FROM ai_summaries ais
      JOIN tweet_content tc ON ais.tweet_content_id = tc.id
      WHERE tc.tweet_id IS NOT NULL
    `);

    // Drop old table and rename new one
    await this.db.run('DROP TABLE ai_summaries');
    await this.db.run('ALTER TABLE ai_summaries_new RENAME TO ai_summaries');

    console.log('✅ ai_summaries table migrated');
  }

  async migrateCompilationItemsTable() {
    console.log('📝 Migrating compilation_items table...');

    // Create new table
    await this.db.run(`
      CREATE TABLE compilation_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        compilation_id INTEGER NOT NULL,
        tweet_id TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        start_time_seconds DECIMAL(10,2),
        end_time_seconds DECIMAL(10,2),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (compilation_id) REFERENCES video_compilations (id) ON DELETE CASCADE,
        FOREIGN KEY (tweet_id) REFERENCES tweet_content (tweet_id) ON DELETE CASCADE
      )
    `);

    // Copy data by joining with tweet_content to get tweet_id
    await this.db.run(`
      INSERT INTO compilation_items_new (id, compilation_id, tweet_id, order_index, start_time_seconds, end_time_seconds, created_at)
      SELECT ci.id, ci.compilation_id, tc.tweet_id, ci.order_index, ci.start_time_seconds, ci.end_time_seconds, ci.created_at
      FROM compilation_items ci
      JOIN tweet_content tc ON ci.tweet_content_id = tc.id
      WHERE tc.tweet_id IS NOT NULL
    `);

    // Drop old table and rename new one
    await this.db.run('DROP TABLE compilation_items');
    await this.db.run('ALTER TABLE compilation_items_new RENAME TO compilation_items');

    console.log('✅ compilation_items table migrated');
  }

  async verifyMigration() {
    console.log('🔍 Verifying migration...');

    const tables = ['twitter_urls', 'tweet_content', 'media_files', 'ai_summaries', 'compilation_items'];
    
    for (const table of tables) {
      const count = await this.db.get(`SELECT COUNT(*) as count FROM ${table}`);
      console.log(`   ${table}: ${count.count} records`);
    }
  }
}

// Run migration if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const migration = new DatabaseMigration();
  
  migration.migrate()
    .then(() => {
      console.log('\n🎉 Migration completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Migration failed:', error);
      process.exit(1);
    });
}

export { DatabaseMigration };
