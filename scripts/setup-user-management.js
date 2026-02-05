const User = require('../src/models/user');
const logger = require('../src/utils/logger');
const { pool } = require('../src/config/database');

async function setupUsers() {
  try {
    logger.info('Setting up user management...');

    // Create admin user
    const adminEmail = 'admin@groupiq.com';
    const existingAdmin = await User.findByEmail(adminEmail);

    if (!existingAdmin) {
      const admin = await User.create({
        email: adminEmail,
        password: 'admin123', // Change this!
        username: 'Admin',
        role: 'admin'
      });
      logger.info('Admin user created', { email: admin.email });
      logger.warn('IMPORTANT: Change default admin password!');
    } else {
      logger.info('Admin user already exists', { email: adminEmail });
    }

    // Create test user
    const testEmail = 'test@groupiq.com';
    const existingTest = await User.findByEmail(testEmail);

    if (!existingTest) {
      const testUser = await User.create({
        email: testEmail,
        password: 'test123',
        username: 'TestUser',
        role: 'user'
      });
      logger.info('Test user created', { email: testUser.email });
    } else {
      logger.info('Test user already exists', { email: testEmail });
    }

    logger.info('User management setup completed!');
    logger.info('Login credentials:');
    logger.info('  Admin: admin@groupiq.com / admin123');
    logger.info('  Test: test@groupiq.com / test123');

    await pool.end();
    process.exit(0);
  } catch (error) {
    logger.error('Error during user management setup', {
      error: error.message,
      stack: error.stack
    });
    await pool.end();
    process.exit(1);
  }
}

setupUsers();
