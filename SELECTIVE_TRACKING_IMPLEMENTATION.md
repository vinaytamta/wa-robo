# Selective Message Tracking Implementation

## Overview
This feature allows users to choose which specific messages to track after adding a group to the configuration. Only selected messages will be tracked for engagement metrics (views, reactions, replies) over the 30-day period.

## How It Works

### User Flow
1. **Add Group**: User adds a group via the Groups Config page
2. **Fetch Messages**: System automatically fetches recent messages (last 30 days) from that group
3. **Select Messages**: A modal appears showing all available messages with:
   - Message content preview
   - Engagement metrics (seen, reactions, replies, engagement rate)
   - Message age
4. **Configure Tracking**: User selects which messages to track
5. **Save**: System updates the tracking status for all messages

### Technical Implementation

#### Backend Changes

**1. LocalDataStore** (`/electron/local-data-store.js`)
- Added `is_tracked` field to all messages (default: `true`)
- Added `updateMessageTracking(messageId, isTracked)` method to update individual message tracking
- Modified `addMessages()` to preserve `is_tracked` status for existing messages and default to `true` for new messages

**2. API Endpoints** (`/electron/main.js`)
- `PUT /api/messages/:id/tracking` - Update tracking status for a single message
- `POST /api/messages/bulk-update-tracking` - Update tracking status for multiple messages at once

**3. Engagement Tracking Service** (`/electron/engagement-tracking-service.js`)
- Modified `findMessagesNeedingTracking()` to filter out messages where `is_tracked === false`
- Only messages with `is_tracked === true` will be processed by the 30-day engagement tracking system

#### Frontend Changes

**1. MessageSelectionModal Component** (`/admin-panel/frontend/components/MessageSelectionModal.tsx`)
- New modal component for message selection
- Features:
  - Search functionality to filter messages
  - Select/deselect all toggle
  - Individual message checkboxes
  - Message preview with engagement metrics
  - Visual indication of selection status

**2. GroupsConfig Component** (`/admin-panel/frontend/components/GroupsConfig.tsx`)
- Modified `handleAddGroup()` to:
  - Add the group to configuration
  - Trigger a test scrape to fetch messages
  - Display MessageSelectionModal with fetched messages
- Added `handleSaveMessageSelection()` to save user's message selection

**3. API Service** (`/admin-panel/frontend/services/api.ts`)
- Added `updateMessageTracking(messageId, isTracked)` method
- Added `bulkUpdateMessageTracking(messageIds[], isTracked)` method

## Data Model

### Message Schema
```javascript
{
  message_id: string,
  content: string,
  message_timestamp: string,
  seen_count: number,
  reactions_count: number,
  replies_count: number,
  engagement_rate: number,
  is_tracked: boolean,  // NEW FIELD - determines if message should be tracked
  created_at: string,
  updated_at: string,
  engagement_history: []  // Snapshots of engagement over time
}
```

## Benefits

1. **Selective Tracking**: Track only important messages instead of all messages
2. **Resource Optimization**: Reduces API calls and processing for untracked messages
3. **Focus on Quality**: Track high-performing or strategic messages
4. **Flexibility**: Change tracking status at any time via the API

## Configuration Files

### Progressive Delays (scraper-config.json)
Messages use age-based delays for accurate data capture:
- Fresh messages (0-24h): 3 seconds
- Week-old messages (1-7d): 8 seconds
- Old messages (7-30d): 15 seconds ← Critical for old messages
- Very old messages (30d+): 20 seconds

### Tracking Intervals (engagement-tracking-config.json)
Refresh frequency based on message age:
- Fresh messages (0-24h): Every 5 minutes
- Recent messages (1-3d): Every 15 minutes
- Week-old messages (3-7d): Every 1 hour
- Old messages (7-30d): Every 6 hours

## Future Enhancements

Possible future improvements:
1. Bulk edit tracking status from Messages page
2. Auto-select high-engagement messages
3. Track message performance predictions
4. Export tracking selection configuration
5. Copy tracking settings between groups

## Testing

To test the feature:
1. Start the Electron app
2. Navigate to Groups Config page
3. Add a new group
4. After adding, the message selection modal should appear
5. Select/deselect messages
6. Save and verify only selected messages are tracked

## Notes

- Existing messages default to `is_tracked: true` to maintain backward compatibility
- The engagement tracking service automatically respects the `is_tracked` flag
- Messages can be re-configured at any time without data loss
- Untracked messages still appear in the UI but won't receive engagement updates
