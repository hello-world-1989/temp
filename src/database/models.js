import { getDatabase } from './db.js';

class TwitterUrlModel {
  constructor() {
    this.db = getDatabase();
  }

  // Add a new Twitter URL
  async addUrl(url) {
    try {
      // Extract tweet ID and username from URL
      const tweetId = this.extractTweetId(url);
      const username = this.extractUsername(url);
      
      if (!tweetId) {
        throw new Error('Could not extract tweet ID from URL');
      }

      const result = await this.db.run(
        `INSERT INTO twitter_urls (tweet_id, url, author_username) VALUES (?, ?, ?)`,
        [tweetId, url, username]
      );

      return {
        tweet_id: tweetId,
        url,
        author_username: username,
        created_at: new Date().toISOString()
      };
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('This Twitter URL has already been added');
      }
      throw error;
    }
  }

  // Get all URLs
  async getAllUrls() {
    return await this.db.all(
      `SELECT * FROM twitter_urls ORDER BY created_at DESC`
    );
  }

  // Get unprocessed URLs
  async getUnprocessedUrls() {
    return await this.db.all(
      `SELECT * FROM twitter_urls WHERE processed = FALSE ORDER BY created_at ASC`
    );
  }

  // Mark URL as processed
  async markAsProcessed(tweetId, status = 'completed') {
    return await this.db.run(
      `UPDATE twitter_urls SET processed = TRUE, last_processed = CURRENT_TIMESTAMP, status = ? WHERE tweet_id = ?`,
      [status, tweetId]
    );
  }

  // Update URL status
  async updateStatus(tweetId, status) {
    return await this.db.run(
      `UPDATE twitter_urls SET status = ? WHERE tweet_id = ?`,
      [status, tweetId]
    );
  }

  // Update author information when tweet content is fetched
  async updateAuthorInfo(tweetId, username, name) {
    return await this.db.run(
      `UPDATE twitter_urls SET author_username = ?, author_name = ? WHERE tweet_id = ?`,
      [username, name, tweetId]
    );
  }

  // Get URL by tweet ID
  async getByTweetId(tweetId) {
    return await this.db.get(
      `SELECT * FROM twitter_urls WHERE tweet_id = ?`,
      [tweetId]
    );
  }

  // Backward compatibility: Get URL by ID (now tweet_id)
  async getById(tweetId) {
    return this.getByTweetId(tweetId);
  }

  // Delete URL
  async deleteUrl(tweetId) {
    return await this.db.run(
      `DELETE FROM twitter_urls WHERE tweet_id = ?`,
      [tweetId]
    );
  }

  // Extract tweet ID from Twitter URL
  extractTweetId(url) {
    const match = url.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  // Extract username from Twitter URL
  extractUsername(url) {
    // Handle different Twitter URL formats:
    // https://twitter.com/username/status/123456789
    // https://x.com/username/status/123456789
    // https://mobile.twitter.com/username/status/123456789
    const match = url.match(/(?:twitter\.com|x\.com|mobile\.twitter\.com)\/([^\/]+)\/status/);
    return match ? match[1] : null;
  }

  // Get statistics
  async getStats() {
    const total = await this.db.get('SELECT COUNT(*) as count FROM twitter_urls');
    const processed = await this.db.get('SELECT COUNT(*) as count FROM twitter_urls WHERE processed = TRUE');
    const pending = await this.db.get('SELECT COUNT(*) as count FROM twitter_urls WHERE processed = FALSE');
    const withUsernames = await this.db.get('SELECT COUNT(*) as count FROM twitter_urls WHERE author_username IS NOT NULL');

    return {
      total: total.count,
      processed: processed.count,
      pending: pending.count,
      with_usernames: withUsernames.count
    };
  }

  // Get URLs by username
  async getByUsername(username) {
    return await this.db.all(
      `SELECT * FROM twitter_urls WHERE author_username = ? ORDER BY created_at DESC`,
      [username]
    );
  }
}

class TweetContentModel {
  constructor() {
    this.db = getDatabase();
  }

  // Save tweet content
  async saveTweetContent(tweetData) {
    const result = await this.db.run(
      `INSERT INTO tweet_content (
        tweet_id, author_id, author_username, author_name, 
        author_profile_image, tweet_text, tweet_created_at, like_count, 
        retweet_count, reply_count, quote_count, bookmark_count, impression_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tweetData.id,
        tweetData.author_id,
        tweetData.username,
        tweetData.name,
        tweetData.profile_image_url,
        tweetData.text,
        tweetData.created_at,
        tweetData.public_metrics?.like_count || 0,
        tweetData.public_metrics?.retweet_count || 0,
        tweetData.public_metrics?.reply_count || 0,
        tweetData.public_metrics?.quote_count || 0,
        tweetData.public_metrics?.bookmark_count || 0,
        tweetData.public_metrics?.impression_count || 0
      ]
    );

    return tweetData.id; // Return the tweet_id instead of auto-increment id
  }

  // Get tweet content by tweet ID
  async getByTweetId(tweetId) {
    return await this.db.get(
      `SELECT * FROM tweet_content WHERE tweet_id = ?`,
      [tweetId]
    );
  }

  // Get all tweet content for compilation
  async getForCompilation(startDate, endDate) {
    return await this.db.all(
      `SELECT tc.*, tu.url 
       FROM tweet_content tc 
       JOIN twitter_urls tu ON tc.tweet_id = tu.tweet_id 
       WHERE tc.fetched_at BETWEEN ? AND ? 
       ORDER BY tc.tweet_created_at DESC`,
      [startDate, endDate]
    );
  }
}

class MediaFileModel {
  constructor() {
    this.db = getDatabase();
  }

  // Save media file info
  async saveMediaFile(tweetId, mediaData) {
    const result = await this.db.run(
      `INSERT INTO media_files (
        tweet_id, media_key, media_type, media_url, 
        width, height, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        tweetId,
        mediaData.media_key,
        mediaData.type,
        mediaData.url,
        mediaData.width,
        mediaData.height,
        mediaData.duration_ms
      ]
    );

    return result.id;
  }

  // Update local path after download
  async updateLocalPath(id, localPath, fileSize) {
    return await this.db.run(
      `UPDATE media_files SET local_path = ?, file_size = ?, downloaded = TRUE WHERE id = ?`,
      [localPath, fileSize, id]
    );
  }

  // Mark download as failed
  async markDownloadFailed(id, error) {
    return await this.db.run(
      `UPDATE media_files SET download_error = ? WHERE id = ?`,
      [error, id]
    );
  }

  // Get media files by tweet ID
  async getByTweetId(tweetId) {
    return await this.db.all(
      `SELECT * FROM media_files WHERE tweet_id = ?`,
      [tweetId]
    );
  }
}

class AISummaryModel {
  constructor() {
    this.db = getDatabase();
  }

  // Save AI summary
  async saveSummary(tweetId, summaryText, summaryType, tokensUsed, processingTime) {
    const result = await this.db.run(
      `INSERT INTO ai_summaries (
        tweet_id, summary_text, summary_type, tokens_used, processing_time_ms
      ) VALUES (?, ?, ?, ?, ?)`,
      [tweetId, summaryText, summaryType, tokensUsed, processingTime]
    );

    return result.id;
  }

  // Get summary by tweet ID
  async getByTweetId(tweetId) {
    return await this.db.get(
      `SELECT * FROM ai_summaries WHERE tweet_id = ? ORDER BY created_at DESC LIMIT 1`,
      [tweetId]
    );
  }
}

class ProcessingLogModel {
  constructor() {
    this.db = getDatabase();
  }

  // Log processing start
  async logStart(processType, details = null) {
    const result = await this.db.run(
      `INSERT INTO processing_logs (process_type, status, details) VALUES (?, ?, ?)`,
      [processType, 'started', details]
    );

    return result.id;
  }

  // Log processing completion
  async logComplete(logId, processingTimeMs, details = null) {
    return await this.db.run(
      `UPDATE processing_logs SET status = 'completed', processing_time_ms = ?, details = ? WHERE id = ?`,
      [processingTimeMs, details, logId]
    );
  }

  // Log processing failure
  async logError(logId, errorMessage, processingTimeMs = null) {
    return await this.db.run(
      `UPDATE processing_logs SET status = 'failed', error_message = ?, processing_time_ms = ? WHERE id = ?`,
      [errorMessage, processingTimeMs, logId]
    );
  }

  // Get recent logs
  async getRecentLogs(limit = 100) {
    return await this.db.all(
      `SELECT * FROM processing_logs ORDER BY created_at DESC LIMIT ?`,
      [limit]
    );
  }
}

export {
  TwitterUrlModel,
  TweetContentModel,
  MediaFileModel,
  AISummaryModel,
  ProcessingLogModel
};
