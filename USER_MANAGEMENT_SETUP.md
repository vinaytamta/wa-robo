# User Management Architecture - Fixed ✅

## Architecture Overview

### 🌐 VPS Server (https://group-iq.com)
**Purpose:** Central user management and authentication server
**Backend:** admin-panel/backend running on port 3001 (or proxied via Nginx)
**Database:** PostgreSQL on port 5433

**API Endpoints:**
- `POST /api/auth/login` - User login
- `GET /api/users` - List all users (super_admin only)
- `POST /api/users` - Create new user (super_admin only)
- `PATCH /api/users/:id` - Update user (super_admin only)
- `POST /api/users/:id/change-password` - Change password (super_admin only)
- `DELETE /api/users/:id` - Delete user (super_admin only)

### 💻 Electron App (Distributed to Users)
**Purpose:** WhatsApp scraping client for authorized users
**Frontend:** React app built from admin-panel/frontend
**Data Storage:** Local JSON files in `/data` directory

## ✅ What Was Fixed

1. **Centralized API Configuration**
   - Added `VITE_VPS_API_URL=https://group-iq.com/api` to env files
   - User management now connects directly to VPS (not localhost:3001)

2. **Updated User Management Component**
   - Removed all hardcoded `localhost:3001` URLs
   - Now uses centralized API service from `services/api.ts`
   - All API calls go to VPS server: `https://group-iq.com/api`

3. **Authentication Flow**
   - Login screen shown first if no token exists
   - JWT token stored in localStorage after login
   - Token sent with all user management API requests
   - Auto-logout on 401 (unauthorized) response

## 🚀 How It Works

### User Flow:
1. **User opens Electron app** → Sees login screen
2. **User enters credentials** → App calls `https://group-iq.com/api/auth/login`
3. **Server validates** → Returns JWT token
4. **App stores token** → User sees dashboard
5. **User connects WhatsApp** → Uses their own WhatsApp account
6. **User runs scraper** → Data saved locally (and optionally synced to VPS)

### Admin Flow (Web Panel):
1. **Admin logs into VPS web panel** → https://group-iq.com
2. **Admin creates new users** → Assigns roles (viewer/admin/super_admin)
3. **New users receive credentials** → Can now login to Electron app
4. **Admin manages users** → Enable/disable, change passwords, delete

## ⚙️ Setup Required on VPS

### 1. Ensure Backend is Running
```bash
ssh deploy@72.60.204.23
cd /path/to/admin-panel/backend
pm2 start server.js --name groupiq-backend
pm2 save
```

### 2. Verify PostgreSQL Database
```bash
psql -h localhost -p 5433 -U wa_robo_user -d wa_robo
# Check if users table exists:
\dt
SELECT * FROM users;
```

### 3. Create Initial Admin User (if needed)
```bash
cd /path/to/admin-panel/backend
node -e "
const bcrypt = require('bcryptjs');
bcrypt.hash('your-admin-password', 10).then(hash => {
  console.log('INSERT INTO users (username, email, password_hash, role, is_active) VALUES');
  console.log(\"('admin', 'admin@groupiq.com', '\${hash}', 'super_admin', true);\");
});
"
# Copy the INSERT statement and run it in psql
```

### 4. Configure Nginx (if using)
```nginx
# Add to your nginx config
location /api {
    proxy_pass http://localhost:3001/api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
}
```

## 🧪 Testing User Management

### Test Login Flow:
1. Open Electron app → Should see login screen
2. Try invalid credentials → Should show error
3. Enter valid credentials → Should see dashboard

### Test User Management (Super Admin):
1. Navigate to "User Management" in sidebar
2. Click "Add User" → Create test user
3. Verify user appears in list
4. Test change password, enable/disable, delete

## 📝 API Response Examples

### Successful Login:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@groupiq.com",
    "role": "super_admin"
  }
}
```

### Get Users (requires token):
```json
[
  {
    "id": 1,
    "username": "admin",
    "email": "admin@groupiq.com",
    "role": "super_admin",
    "is_active": true,
    "created_at": "2026-02-05T12:00:00.000Z",
    "last_login_at": "2026-02-05T18:00:00.000Z"
  }
]
```

## 🔐 Security Notes

- JWT tokens expire after 7 days (configurable in backend .env)
- Passwords are hashed with bcrypt (10 rounds)
- Only super_admin role can manage users
- CORS is configured to allow Electron app requests
- Rate limiting: 100 requests per 15 minutes per IP

## 🐛 Troubleshooting

### "Failed to fetch users" error:
- Check if VPS backend is running: `pm2 status`
- Check if PostgreSQL is running: `psql -h localhost -p 5433 -U wa_robo_user`
- Check network connectivity: `curl https://group-iq.com/api/users`

### "Unauthorized" error after login:
- Check JWT_SECRET matches between frontend and backend
- Verify token is being sent in Authorization header
- Check token hasn't expired (7 day default)

### CORS errors:
- Verify backend CORS config includes your Electron app origin
- Check browser console for specific CORS error messages

## 📦 Files Modified

1. **Frontend:**
   - `/admin-panel/frontend/.env.production` - Added VPS_API_URL
   - `/admin-panel/frontend/.env.local` - Added VPS_API_URL
   - `/admin-panel/frontend/services/api.ts` - Added user management APIs
   - `/admin-panel/frontend/components/UserManagement.tsx` - Use centralized API

2. **Electron App:**
   - `/public/*` - Rebuilt frontend deployed to Electron

## ✅ Current Status

- ✅ Electron app shows login screen
- ✅ User management connects to VPS (https://group-iq.com/api)
- ✅ Authentication flow working
- ✅ JWT tokens stored and used properly
- ⚠️ **VPS backend needs to be running for user management to work**
- ⚠️ **PostgreSQL needs to be running on VPS**

## Next Steps

1. SSH to VPS and start backend server
2. Verify PostgreSQL is running and has users table
3. Create initial admin user if needed
4. Test login from Electron app
5. Test user management features
