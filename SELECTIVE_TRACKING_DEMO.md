# Selective Message Tracking - Feature Demo

## 🎯 What Was Implemented

You can now **choose which messages to track** after adding a group to your WhatsApp analytics system!

## 🔄 User Flow

```
1. Navigate to Groups Config Page
        ↓
2. Click "Add Group" Button
        ↓
3. Enter Group Name → "Marketing Team"
        ↓
4. Click "Add Group"
        ↓
5. System Fetches Messages (last 30 days)
        ↓
6. 📋 MESSAGE SELECTION MODAL APPEARS
   ┌────────────────────────────────────────┐
   │  Select Messages to Track              │
   │  Group: Marketing Team                 │
   │                                        │
   │  [Search messages...]      25/50 sel. │
   │                                        │
   │  ☑ Select All                          │
   │  ────────────────────────────────────  │
   │  ✓ "Q4 Sales Results are in! 🎉"      │
   │    👁 50 | ❤️ 15 | 💬 8 | 45.2%        │
   │                                        │
   │  ✓ "Team meeting at 3pm today"         │
   │    👁 35 | ❤️ 5 | 💬 2 | 28.5%         │
   │                                        │
   │  ☐ "Lunch break announcement"          │
   │    👁 20 | ❤️ 3 | 💬 0 | 15.0%         │
   │                                        │
   │            [Cancel]  [Save Selection]  │
   └────────────────────────────────────────┘
        ↓
7. Select Messages You Want to Track
        ↓
8. Click "Save Selection"
        ↓
9. ✅ Only Selected Messages Are Tracked!
```

## 🎨 Features

### Message Selection Modal
- **Search**: Filter messages by content
- **Select All/None**: Quick toggle for all messages
- **Individual Selection**: Click any message to toggle
- **Engagement Preview**: See current metrics before selecting
- **Message Age**: View how old each message is
- **Visual Feedback**: Selected messages highlighted in blue

### Smart Tracking
- **30-Day Tracking**: Selected messages tracked for 30 days
- **Progressive Delays**: Older messages get longer fetch delays (15s for 7-30 day old messages)
- **Engagement History**: Snapshots stored over time
- **Resource Efficient**: Only selected messages consume API calls

## 📊 What Gets Tracked

### For Selected Messages:
✅ View count (seen_count)
✅ Reaction count
✅ Reply count
✅ Engagement rate
✅ Historical snapshots (engagement curves over time)
✅ Automatic refresh based on message age:
   - 0-24h old: Every 5 minutes
   - 1-3d old: Every 15 minutes
   - 3-7d old: Every 1 hour
   - 7-30d old: Every 6 hours

### For Unselected Messages:
❌ Not tracked (saves resources)
❌ No engagement updates
✓ Still visible in UI (but data frozen)

## 🔧 Technical Details

### Backend
- New `is_tracked` field on all messages
- API endpoints for updating tracking status
- Engagement tracking service respects `is_tracked` flag
- Bulk update support for multiple messages

### Frontend
- New `MessageSelectionModal` component
- Integration with Groups Config workflow
- Automatic test scrape after adding group
- Bulk API operations for saving selection

## 💡 Use Cases

1. **High-Value Content Only**: Track only important announcements
2. **A/B Testing**: Track specific test messages to compare performance
3. **Resource Management**: Reduce API calls by tracking fewer messages
4. **Strategic Analysis**: Focus on key messages that drive engagement

## 🚀 How to Use

### After Adding a Group:
1. Modal appears automatically with all your messages
2. Review the list - see content, engagement, and age
3. Deselect messages you don't want to track
4. Click "Save Selection"
5. Done! Only selected messages will be tracked

### Re-configure Later:
Currently, you can use the API endpoints to change tracking status:
```javascript
// Update single message
PUT /api/messages/:id/tracking
{ "is_tracked": true }

// Bulk update
POST /api/messages/bulk-update-tracking
{ "message_ids": ["id1", "id2"], "is_tracked": false }
```

## 📝 Example Workflow

**Scenario**: You run a sales team group with 100 messages/month

**Before**: All 100 messages tracked → 100 × 30 days = 3,000 tracking updates

**After**: Select 20 key messages → 20 × 30 days = 600 tracking updates

**Benefit**: 80% reduction in API calls, faster processing, focused analytics!

## ⚠️ Important Notes

1. **Existing Messages**: All existing messages default to `is_tracked: true`
2. **New Messages**: Newly scraped messages default to tracked
3. **WhatsApp Connection**: Must be connected to fetch messages for selection
4. **Test Scrape**: Uses same logic as regular scraping (last 30 days)
5. **Data Preservation**: Untracking doesn't delete existing data, just stops updates

## 🎉 Success!

The feature is now fully implemented and ready to use!

Next time you add a group, you'll see the message selection modal. Pick the messages you care about, and let the system handle the rest! 🚀
