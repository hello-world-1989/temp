import sqlite3 from 'sqlite3';
// const path = require('path');
import * as path from 'path';
// const fs = require('fs-extra');
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const { verbose } = sqlite3;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class Database {
  constructor() {
    this.db = null;
    this.dbPath = path.join(__dirname, '../data/db.sqlite');
  }

  async initialize() {
    try {
      // Ensure data directory exists
      await fs.ensureDir(path.dirname(this.dbPath));
      
      // Create database connection
      const sqlite3Verbose = verbose();
      this.db = new sqlite3Verbose.Database(this.dbPath, (err) => {
        if (err) {
          console.error('Error opening database:', err.message);
          throw err;
        }
        console.log('📄 Connected to SQLite database');
      });

      // Enable foreign keys
      await this.run('PRAGMA foreign_keys = ON');

      // Create tables
      await this.createTables();
      
      console.log('✅ Database initialized successfully');
    } catch (error) {
      console.error('❌ Database initialization failed:', error);
      throw error;
    }
  }

  async createTables() {
    const tables = [
      // Twitter URLs table
      `CREATE TABLE IF NOT EXISTS twitter_urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        tweet_id TEXT,
        author_username TEXT,
        author_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed BOOLEAN DEFAULT FALSE,
        last_processed DATETIME,
        status TEXT DEFAULT 'pending'
      )`,

      // Tweet content table
      `CREATE TABLE IF NOT EXISTS tweet_content (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url_id INTEGER NOT NULL,
        tweet_id TEXT NOT NULL,
        author_id TEXT,
        author_username TEXT,
        author_name TEXT,
        author_profile_image TEXT,
        tweet_text TEXT,
        created_at DATETIME,
        like_count INTEGER DEFAULT 0,
        retweet_count INTEGER DEFAULT 0,
        reply_count INTEGER DEFAULT 0,
        quote_count INTEGER DEFAULT 0,
        bookmark_count INTEGER DEFAULT 0,
        impression_count INTEGER DEFAULT 0,
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (url_id) REFERENCES twitter_urls (id) ON DELETE CASCADE
      )`,

      // Media files table (videos, images)
      `CREATE TABLE IF NOT EXISTS media_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_content_id INTEGER NOT NULL,
        media_key TEXT,
        media_type TEXT NOT NULL, -- 'video', 'image', 'gif'
        media_url TEXT,
        local_path TEXT,
        width INTEGER,
        height INTEGER,
        duration_ms INTEGER,
        file_size INTEGER,
        downloaded BOOLEAN DEFAULT FALSE,
        download_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tweet_content_id) REFERENCES tweet_content (id) ON DELETE CASCADE
      )`,

      // AI summaries table
      `CREATE TABLE IF NOT EXISTS ai_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_content_id INTEGER NOT NULL,
        summary_text TEXT,
        summary_type TEXT DEFAULT 'gemini', -- 'gemini', 'openai', etc.
        tokens_used INTEGER,
        processing_time_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tweet_content_id) REFERENCES tweet_content (id) ON DELETE CASCADE
      )`,

      // Video compilations table
      `CREATE TABLE IF NOT EXISTS video_compilations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        compilation_date DATE,
        video_path TEXT,
        thumbnail_path TEXT,
        duration_seconds INTEGER,
        file_size INTEGER,
        youtube_video_id TEXT,
        youtube_upload_status TEXT DEFAULT 'pending', -- 'pending', 'uploading', 'uploaded', 'failed'
        upload_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Compilation items table (which tweets are in which compilation)
      `CREATE TABLE IF NOT EXISTS compilation_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        compilation_id INTEGER NOT NULL,
        tweet_content_id INTEGER NOT NULL,
        order_index INTEGER NOT NULL,
        start_time_seconds DECIMAL(10,2),
        end_time_seconds DECIMAL(10,2),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (compilation_id) REFERENCES video_compilations (id) ON DELETE CASCADE,
        FOREIGN KEY (tweet_content_id) REFERENCES tweet_content (id) ON DELETE CASCADE
      )`,

      // System settings table
      `CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Processing logs table
      `CREATE TABLE IF NOT EXISTS processing_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        process_type TEXT NOT NULL, -- 'twitter_fetch', 'ai_summary', 'video_compilation', 'youtube_upload'
        status TEXT NOT NULL, -- 'started', 'completed', 'failed'
        details TEXT,
        error_message TEXT,
        processing_time_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    for (const tableSQL of tables) {
      await this.run(tableSQL);
    }

    // Create indexes for better performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_twitter_urls_tweet_id ON twitter_urls(tweet_id)',
      'CREATE INDEX IF NOT EXISTS idx_twitter_urls_processed ON twitter_urls(processed)',
      'CREATE INDEX IF NOT EXISTS idx_tweet_content_url_id ON tweet_content(url_id)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_tweet_content_id ON media_files(tweet_content_id)',
      'CREATE INDEX IF NOT EXISTS idx_ai_summaries_tweet_content_id ON ai_summaries(tweet_content_id)',
      'CREATE INDEX IF NOT EXISTS idx_compilation_items_compilation_id ON compilation_items(compilation_id)',
      'CREATE INDEX IF NOT EXISTS idx_processing_logs_created_at ON processing_logs(created_at)'
    ];

    for (const indexSQL of indexes) {
      await this.run(indexSQL);
    }
  }

  // Promisify database operations
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ id: this.lastID, changes: this.changes });
        }
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  async close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            reject(err);
          } else {
            console.log('📄 Database connection closed');
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  // Health check
  async isHealthy() {
    try {
      await this.get('SELECT 1');
      return true;
    } catch (error) {
      console.error('Database health check failed:', error);
      return false;
    }
  }
}

// Singleton instance
let dbInstance = null;

export function getDatabase() {
  if (!dbInstance) {
    dbInstance = new Database();
  }
  return dbInstance;
}


