// DOM Elements
const urlForm = document.getElementById('urlForm');
const twitterUrlInput = document.getElementById('twitterUrl');
const addButton = document.getElementById('addButton');
const messageContainer = document.getElementById('messageContainer');
const messageText = document.getElementById('messageText');
const urlList = document.getElementById('urlList');

// State
let urls = [];

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    loadUrls();
    updateSystemStatus();
    checkServiceStatus();
    checkSchedulerStatus();
});

// Form submission handler
urlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const url = twitterUrlInput.value.trim();
    if (!url) return;
    
    // Validate Twitter URL format
    if (!isValidTwitterUrl(url)) {
        showMessage('Please enter a valid Twitter URL (e.g., https://twitter.com/user/status/123456)', 'error');
        return;
    }
    
    // Check for duplicates
    if (urls.some(item => item.url === url)) {
        showMessage('This Twitter URL has already been added!', 'error');
        return;
    }
    
    await addTwitterUrl(url);
});

// Validate Twitter URL format
function isValidTwitterUrl(url) {
    const twitterUrlRegex = /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/\w+\/status\/\d+/i;
    return twitterUrlRegex.test(url);
}

// Add Twitter URL to the system
async function addTwitterUrl(url) {
    try {
        setLoading(true);

        console.log('Adding Twitter URL:', url);
        
        const response = await fetch('/api/add-url', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showMessage('Twitter URL added successfully! 🎉', 'success');
            twitterUrlInput.value = '';
            await loadUrls(); // Refresh the list
        } else {
            showMessage(data.error || 'Failed to add URL', 'error');
        }
    } catch (error) {
        console.error('Error adding URL:', error);
        showMessage('Network error. Please try again.', 'error');
    } finally {
        setLoading(false);
    }
}

// Load and display URLs
async function loadUrls() {
    try {
        const response = await fetch('/api/urls');
        const data = await response.json();
        
        urls = data.urls || [];
        renderUrlList();
        updateStats(data.stats);
    } catch (error) {
        console.error('Error loading URLs:', error);
        showMessage('Failed to load URLs', 'error');
    }
}

// Update statistics display
function updateStats(stats) {
    if (!stats) return;
    
    // Update the empty state or add stats display
    const statsHtml = `
        <div class="stats-summary">
            <span>Total: ${stats.total}</span>
            <span>Processed: ${stats.processed}</span>
            <span>Pending: ${stats.pending}</span>
        </div>
    `;
    
    // Add stats to the url list section header
    const urlListSection = document.querySelector('.url-list-section h2');
    urlListSection.innerHTML = `Added URLs ${statsHtml}`;
}

// Render the URL list
function renderUrlList() {
    if (urls.length === 0) {
        urlList.innerHTML = '<p class="empty-state">No URLs added yet. Add your first Twitter URL above!</p>';
        return;
    }
    
    const urlItems = urls.map(item => `
        <div class="url-item ${item.processed ? 'processed' : ''}" data-id="${item.id}">
            <div class="url-info">
                <span class="url-text">${item.url}</span>
                <span class="url-meta">
                    <span class="url-date">${formatDate(item.created_at)}</span>
                    <span class="status-badge status-${item.status || 'pending'}">${item.status || 'pending'}</span>
                </span>
            </div>
            <div class="url-actions">
                ${!item.processed ? `
                    <button class="process-btn" onclick="processUrl(${item.id})" 
                            ${item.status === 'processing' ? 'disabled' : ''}>
                        ${item.status === 'processing' ? 'Processing...' : 'Process Now'}
                    </button>
                ` : `
                    <span class="processed-indicator">✅ Processed</span>
                `}
            </div>
        </div>
    `).join('');
    
    urlList.innerHTML = urlItems;
}

// Show success/error messages
function showMessage(message, type) {
    messageText.textContent = message;
    messageContainer.className = `message-container ${type}`;
    messageContainer.classList.remove('hidden');
    
    // Auto-hide after 5 seconds
    setTimeout(() => {
        messageContainer.classList.add('hidden');
    }, 5000);
}

// Set loading state
function setLoading(isLoading) {
    addButton.disabled = isLoading;
    addButton.innerHTML = isLoading ? '<span class="loading"></span> Adding...' : 'Add URL';
}

// Format date for display
function formatDate(dateString) {
    if (!dateString) return 'Just now';
    
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = (now - date) / (1000 * 60 * 60);
    
    if (diffInHours < 1) {
        return 'Just now';
    } else if (diffInHours < 24) {
        return `${Math.floor(diffInHours)} hours ago`;
    } else {
        return date.toLocaleDateString();
    }
}

// Update system status indicators
async function updateSystemStatus() {
    // Database is always connected if the server is running
    document.getElementById('dbStatus').textContent = 'Connected ✅';
    
    // Calculate next Sunday
    const nextSunday = getNextSunday();
    document.getElementById('nextProcessing').textContent = nextSunday.toLocaleDateString();
}

// Check service status (Twitter API, Gemini AI, YouTube API, FFmpeg)
async function checkServiceStatus() {
    try {
        const response = await fetch('/api/test-services');
        const data = await response.json();
        
        if (data.success) {
            // Update Twitter status
            const twitterElement = document.getElementById('twitterStatus');
            if (data.services.twitter.valid) {
                twitterElement.textContent = 'Connected ✅';
                twitterElement.className = 'status-value success';
            } else if (data.services.twitter.configured) {
                twitterElement.textContent = 'Invalid Token ❌';
                twitterElement.className = 'status-value error';
            } else {
                twitterElement.textContent = 'Not Configured ⚠️';
                twitterElement.className = 'status-value warning';
            }
            
            // Update Gemini status
            const geminiElement = document.getElementById('geminiStatus');
            if (data.services.gemini.valid) {
                geminiElement.textContent = 'Connected ✅';
                geminiElement.className = 'status-value success';
            } else if (data.services.gemini.configured) {
                geminiElement.textContent = 'Invalid Key ❌';
                geminiElement.className = 'status-value error';
            } else {
                geminiElement.textContent = 'Not Configured ⚠️';
                geminiElement.className = 'status-value warning';
            }
            
            // Update YouTube status
            const youtubeElement = document.getElementById('youtubeStatus');
            if (data.services.youtube.valid) {
                youtubeElement.textContent = 'Connected ✅';
                youtubeElement.className = 'status-value success';
            } else if (data.services.youtube.needsAuth) {
                youtubeElement.textContent = 'Needs Auth ⚠️';
                youtubeElement.className = 'status-value warning';
                if (data.services.youtube.authUrl) {
                    youtubeElement.onclick = () => window.open(data.services.youtube.authUrl, '_blank');
                    youtubeElement.style.cursor = 'pointer';
                }
            } else if (data.services.youtube.configured) {
                youtubeElement.textContent = 'Invalid Credentials ❌';
                youtubeElement.className = 'status-value error';
            } else {
                youtubeElement.textContent = 'Not Configured ⚠️';
                youtubeElement.className = 'status-value warning';
            }
            
            // Update FFmpeg status (add to status grid if not exists)
            let ffmpegElement = document.getElementById('ffmpegStatus');
            if (!ffmpegElement) {
                // Add FFmpeg status item
                const statusGrid = document.querySelector('.status-grid');
                const ffmpegItem = document.createElement('div');
                ffmpegItem.className = 'status-item';
                ffmpegItem.innerHTML = `
                    <span class="status-label">FFmpeg:</span>
                    <span class="status-value" id="ffmpegStatus">Checking...</span>
                `;
                statusGrid.appendChild(ffmpegItem);
                ffmpegElement = document.getElementById('ffmpegStatus');
            }
            
            if (data.services.ffmpeg.installed) {
                ffmpegElement.textContent = 'Installed ✅';
                ffmpegElement.className = 'status-value success';
            } else {
                ffmpegElement.textContent = 'Not Installed ❌';
                ffmpegElement.className = 'status-value error';
            }
        }
    } catch (error) {
        console.error('Error checking service status:', error);
    }
}

// Process a specific URL
async function processUrl(urlId) {
    try {
        const button = document.querySelector(`[data-id="${urlId}"] .process-btn`);
        if (button) {
            button.disabled = true;
            button.textContent = 'Processing...';
        }
        
        const response = await fetch(`/api/process-url/${urlId}`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showMessage(`✅ Successfully processed tweet from @${data.data.author}!`, 'success');
            await loadUrls(); // Refresh the list
        } else {
            showMessage(`❌ Processing failed: ${data.error}`, 'error');
            if (button) {
                button.disabled = false;
                button.textContent = 'Process Now';
            }
        }
    } catch (error) {
        console.error('Error processing URL:', error);
        showMessage('❌ Network error during processing', 'error');
        
        const button = document.querySelector(`[data-id="${urlId}"] .process-btn`);
        if (button) {
            button.disabled = false;
            button.textContent = 'Process Now';
        }
    }
}

// Calculate next Sunday
function getNextSunday() {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilSunday = dayOfWeek === 0 ? 7 : 7 - dayOfWeek;
    
    const nextSunday = new Date(today);
    nextSunday.setDate(today.getDate() + daysUntilSunday);
    nextSunday.setHours(9, 0, 0, 0); // 9:00 AM
    
    return nextSunday;
}

// Auto-refresh URL list every 30 seconds
setInterval(loadUrls, 30000);

// Check scheduler status
async function checkSchedulerStatus() {
    try {
        const response = await fetch('/api/scheduler/status');
        const data = await response.json();
        
        if (data.success) {
            const nextProcessingElement = document.getElementById('nextProcessing');
            if (data.scheduler.timeUntilNextRun) {
                nextProcessingElement.textContent = `${data.scheduler.timeUntilNextRun} (${data.scheduler.nextRun ? new Date(data.scheduler.nextRun).toLocaleDateString() : 'Unknown'})`;
            }
            
            // Add scheduler controls if not exists
            let schedulerControls = document.getElementById('schedulerControls');
            if (!schedulerControls) {
                const statusSection = document.querySelector('.status-section');
                schedulerControls = document.createElement('div');
                schedulerControls.id = 'schedulerControls';
                schedulerControls.className = 'scheduler-controls';
                schedulerControls.innerHTML = `
                    <h3>Scheduler Controls</h3>
                    <button id="triggerProcessing" class="process-btn" ${data.scheduler.isRunning ? 'disabled' : ''}>
                        ${data.scheduler.isRunning ? 'Processing...' : 'Trigger Now'}
                    </button>
                    <div class="scheduler-stats">
                        <span>Last run: ${data.scheduler.lastRun ? new Date(data.scheduler.lastRun).toLocaleString() : 'Never'}</span>
                        ${data.scheduler.stats.totalProcessed > 0 ? `
                            <span>Last batch: ${data.scheduler.stats.successCount}/${data.scheduler.stats.totalProcessed} successful</span>
                        ` : ''}
                    </div>
                `;
                statusSection.appendChild(schedulerControls);
                
                // Add event listener for trigger button
                document.getElementById('triggerProcessing').addEventListener('click', triggerProcessing);
            }
        }
    } catch (error) {
        console.error('Error checking scheduler status:', error);
    }
}

// Trigger manual processing
async function triggerProcessing() {
    try {
        const button = document.getElementById('triggerProcessing');
        button.disabled = true;
        button.textContent = 'Triggering...';
        
        const response = await fetch('/api/scheduler/trigger', {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showMessage('🚀 Weekly processing triggered manually!', 'success');
            button.textContent = 'Processing...';
            
            // Refresh status after a delay
            setTimeout(() => {
                checkSchedulerStatus();
                loadUrls();
            }, 2000);
        } else {
            showMessage(`❌ Failed to trigger processing: ${data.error}`, 'error');
            button.disabled = false;
            button.textContent = 'Trigger Now';
        }
    } catch (error) {
        console.error('Error triggering processing:', error);
        showMessage('❌ Network error during trigger', 'error');
        
        const button = document.getElementById('triggerProcessing');
        button.disabled = false;
        button.textContent = 'Trigger Now';
    }
}
