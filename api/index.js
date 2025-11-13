// api/index.js
/**
 * EcoTrack API server (Vercel serverless-ready)
 * - All original routes (challenges, user-challenges, tips, events, users, stats)
 * - Uses MongoDB connection reuse across invocations (global cache)
 * - No app.listen() — exports a serverless handler (serverless-http)
 *
 * Setup:
 * 1. npm install serverless-http mongodb dotenv cors
 * 2. In Vercel set env vars: USER_DB, USER_PASS
 * 3. Deploy — Vercel will use this file as a Function at /api/*
 */

const express = require('express');
const cors = require('cors');
const serverless = require('serverless-http');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Env validation (fail fast if missing) ---
const USER_DB = process.env.USER_DB;
const USER_PASS = process.env.USER_PASS;
if (!USER_DB || !USER_PASS) {
  throw new Error('Missing USER_DB or USER_PASS environment variables.');
}
const uri = `mongodb+srv://${encodeURIComponent(USER_DB)}:${encodeURIComponent(USER_PASS)}@cluster0.9lf33xm.mongodb.net/ecoTrackDB?retryWrites=true&w=majority&appName=Cluster0`;

// --- MongoDB client reuse for serverless ---
let cachedClient = global._mongoClient || null;
let cachedDb = global._mongoDb || null;

async function getDb() {
  if (cachedClient && cachedDb) return { client: cachedClient, db: cachedDb };

  const client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false,
      deprecationErrors: true,
    },
  });
  await client.connect();
  const db = client.db('ecoTrackDB');

  global._mongoClient = client;
  global._mongoDb = db;
  cachedClient = client;
  cachedDb = db;
  return { client, db };
}

// Temporary auth for dev: expects header x-user-email
function requireAuth(req, res, next) {
  const userEmail = req.header('x-user-email') || null;
  if (!userEmail) {
    return res.status(401).json({ message: 'Unauthorized. Send x-user-email header for now.' });
  }
  req.user = { email: userEmail };
  next();
}

// simple immediate health check
app.get('/', (req, res) => res.send('server is running'));

// Attach routes once (idempotent)
async function attachRoutes() {
  if (app.locals._routesAttached) return;
  app.locals._routesAttached = true;

  const { db } = await getDb();

  const challengesCollection = db.collection('challenges');
  const tipsCollection = db.collection('tips');
  const eventsCollection = db.collection('events');
  const usersCollection = db.collection('users');
  const userChallengesCollection = db.collection('userChallenges');

  /* -------------------------
     CHALLENGES
  ------------------------- */

  // GET list with filters, pagination, sort
  app.get('/api/challenges', async (req, res) => {
    try {
      const {
        category,
        startDate_gte,
        endDate_lte,
        participants_gte,
        participants_lte,
        search,
        page = 1,
        limit = 12,
        sort = '-createdAt',
        status, // optional: 'ongoing'
      } = req.query;

      const q = {};

      if (category) q.category = { $in: String(category).split(',').map(s => s.trim()) };
      if (startDate_gte) q.startDate = { ...(q.startDate || {}), $gte: new Date(startDate_gte) };
      if (endDate_lte) q.endDate = { ...(q.endDate || {}), $lte: new Date(endDate_lte) };
      if (participants_gte || participants_lte) {
        q.participants = {};
        if (participants_gte) q.participants.$gte = Number(participants_gte);
        if (participants_lte) q.participants.$lte = Number(participants_lte);
      }
      if (search) {
        // basic safeguard: limit regex length
        const s = String(search).slice(0, 120);
        q.$or = [{ title: new RegExp(s, 'i') }, { description: new RegExp(s, 'i') }];
      }

      if (status === 'ongoing') {
        const now = new Date();
        q.startDate = { ...(q.startDate || {}), $lte: now };
        q.endDate = { ...(q.endDate || {}), $gte: now };
      }

      const skip = (Number(page) - 1) * Number(limit);
      const sortObj = {};
      if (sort) {
        if (sort.startsWith('-')) sortObj[sort.slice(1)] = -1;
        else sortObj[sort] = 1;
      } else sortObj.createdAt = -1;

      const cursor = challengesCollection.find(q).sort(sortObj).skip(skip).limit(Number(limit));
      const items = await cursor.toArray();
      const total = await challengesCollection.countDocuments(q);

      res.json({ items, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
    } catch (err) {
      console.error('GET /api/challenges error:', err);
      res.status(500).json({ message: 'Failed to get challenges', error: err.message });
    }
  });

  // Robust GET by id — supports ObjectId and string _id fallback
  app.get('/api/challenges/:id', async (req, res) => {
    const rawId = req.params.id;
    try {
      let query = null;

      if (ObjectId.isValid(rawId) && String(new ObjectId(rawId)) === rawId) {
        query = { _id: new ObjectId(rawId) };
      } else {
        query = {
          $or: [
            { _id: rawId },
            { id: rawId },
            { 'meta.id': rawId },
          ]
        };
      }

      const doc = await challengesCollection.findOne(query);
      if (!doc) return res.status(404).json({ message: 'Challenge not found' });
      res.json(doc);
    } catch (err) {
      console.error('GET /api/challenges/:id error:', err);
      res.status(500).json({ message: 'Failed to get challenge', error: err.message });
    }
  });

  // Create challenge (protected)
  app.post('/api/challenges', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const required = ['title', 'category', 'description', 'duration', 'target', 'imageUrl', 'startDate', 'endDate'];
      for (const f of required) {
        if (!body[f]) return res.status(400).json({ message: `${f} is required` });
      }

      if (new Date(body.endDate) <= new Date(body.startDate)) {
        return res.status(400).json({ message: 'endDate must be after startDate' });
      }

      const newChallenge = {
        title: String(body.title),
        category: String(body.category),
        description: String(body.description),
        duration: Number(body.duration),
        target: String(body.target),
        participants: Number(body.participants) || 0,
        impactMetric: body.impactMetric || '',
        createdBy: req.user.email,
        startDate: new Date(body.startDate),
        endDate: new Date(body.endDate),
        imageUrl: String(body.imageUrl),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await challengesCollection.insertOne(newChallenge);
      res.status(201).json({ success: true, challengeId: result.insertedId, challenge: { _id: result.insertedId, ...newChallenge } });
    } catch (err) {
      console.error('POST /api/challenges error:', err);
      res.status(500).json({ message: 'Failed to create challenge', error: err.message });
    }
  });

  // Update challenge (protected, owner only)
  app.patch('/api/challenges/:id', requireAuth, async (req, res) => {
    try {
      const id = req.params.id;
      let filter;
      if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) filter = { _id: new ObjectId(id) };
      else filter = { _id: id };

      const existing = await challengesCollection.findOne(filter);
      if (!existing) return res.status(404).json({ message: 'Challenge not found' });
      if (existing.createdBy !== req.user.email) return res.status(403).json({ message: 'Forbidden: only owner can update' });

      const updatedData = { ...req.body, updatedAt: new Date() };
      delete updatedData._id;

      const result = await challengesCollection.updateOne(filter, { $set: updatedData });
      res.json({ success: true, modifiedCount: result.modifiedCount });
    } catch (err) {
      console.error('PATCH /api/challenges/:id error:', err);
      res.status(500).json({ message: 'Error updating challenge', error: err.message });
    }
  });

  // Delete challenge (protected, owner only)
  app.delete('/api/challenges/:id', requireAuth, async (req, res) => {
    try {
      const id = req.params.id;
      let filter;
      if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) filter = { _id: new ObjectId(id) };
      else filter = { _id: id };

      const existing = await challengesCollection.findOne(filter);
      if (!existing) return res.status(404).json({ message: 'Challenge not found' });
      if (existing.createdBy !== req.user.email) return res.status(403).json({ message: 'Forbidden: only owner can delete' });

      const result = await challengesCollection.deleteOne(filter);
      res.json({ success: true, deletedCount: result.deletedCount });
    } catch (err) {
      console.error('DELETE /api/challenges/:id error:', err);
      res.status(500).json({ message: 'Failed to delete challenge', error: err.message });
    }
  });

  // Join challenge (protected)
  app.post('/api/challenges/join/:id', requireAuth, async (req, res) => {
    try {
      const challengeId = req.params.id;
      const userEmail = req.user.email;

      let challengeFilter;
      if (ObjectId.isValid(challengeId) && String(new ObjectId(challengeId)) === challengeId) challengeFilter = { _id: new ObjectId(challengeId) };
      else challengeFilter = { _id: challengeId };

      const challenge = await challengesCollection.findOne(challengeFilter);
      if (!challenge) return res.status(404).json({ message: 'Challenge not found' });

      const exists = await userChallengesCollection.findOne({ userId: userEmail, challengeId: challenge._id || challengeId });
      if (exists) return res.status(200).json({ message: 'Already joined', userChallenge: exists });

      const uc = {
        userId: userEmail,
        challengeId: challenge._id || challengeId,
        status: 'Ongoing',
        progress: 0,
        progressLogs: [],
        joinDate: new Date(),
        lastUpdated: new Date(),
      };

      const insertResult = await userChallengesCollection.insertOne(uc);

      await challengesCollection.updateOne({ _id: challenge._id || challengeId }, { $inc: { participants: 1 } });

      res.status(201).json({ success: true, userChallengeId: insertResult.insertedId, userChallenge: { _id: insertResult.insertedId, ...uc } });
    } catch (err) {
      console.error('POST /api/challenges/join/:id error:', err);
      res.status(500).json({ message: 'Failed to join challenge', error: err.message });
    }
  });

  /* -------------------------
     USER-CHALLENGES
  ------------------------- */

  // Get logged-in user's challenges (protected)
  app.get('/api/user-challenges/me', requireAuth, async (req, res) => {
    try {
      const userEmail = req.user.email;
      const ucs = await userChallengesCollection.find({ userId: userEmail }).toArray();

      const populated = await Promise.all(ucs.map(async (uc) => {
        const ch = (uc.challengeId && ObjectId.isValid(String(uc.challengeId)))
          ? await challengesCollection.findOne({ _id: new ObjectId(String(uc.challengeId)) })
          : await challengesCollection.findOne({ _id: String(uc.challengeId) }) || null;
        return { ...uc, challenge: ch };
      }));

      res.json(populated);
    } catch (err) {
      console.error('GET /api/user-challenges/me error:', err);
      res.status(500).json({ message: 'Failed to fetch user challenges', error: err.message });
    }
  });

  // update progress on a user-challenge
  app.patch('/api/user-challenges/:id/progress', requireAuth, async (req, res) => {
    try {
      const id = req.params.id;
      const { progress, addLogValue } = req.body;
      const uc = await userChallengesCollection.findOne({ _id: new ObjectId(id) });
      if (!uc) return res.status(404).json({ message: 'UserChallenge not found' });
      if (uc.userId !== req.user.email) return res.status(403).json({ message: 'Forbidden' });

      const updates = {};
      if (typeof progress === 'number') {
        updates.progress = Math.min(100, Math.max(0, progress));
        updates.status = updates.progress >= 100 ? 'Finished' : 'Ongoing';
      }
      if (typeof addLogValue === 'number') {
        await userChallengesCollection.updateOne(
          { _id: new ObjectId(id) },
          { $push: { progressLogs: { date: new Date(), value: Number(addLogValue) } } }
        );
      }
      updates.lastUpdated = new Date();

      const result = await userChallengesCollection.updateOne({ _id: new ObjectId(id) }, { $set: updates });
      const updated = await userChallengesCollection.findOne({ _id: new ObjectId(id) });
      res.json({ success: true, updated });
    } catch (err) {
      console.error('PATCH /api/user-challenges/:id/progress error:', err);
      res.status(500).json({ message: 'Failed to update progress', error: err.message });
    }
  });

  // leave / delete a user-challenge
  app.delete('/api/user-challenges/:id', requireAuth, async (req, res) => {
    try {
      const id = req.params.id;
      const uc = await userChallengesCollection.findOne({ _id: new ObjectId(id) });
      if (!uc) return res.status(404).json({ message: 'Not found' });
      if (uc.userId !== req.user.email) return res.status(403).json({ message: 'Forbidden' });

      await userChallengesCollection.deleteOne({ _id: new ObjectId(id) });

      await challengesCollection.updateOne(
        { _id: uc.challengeId, participants: { $gt: 0 } },
        { $inc: { participants: -1 } }
      );

      res.json({ success: true, message: 'Left challenge' });
    } catch (err) {
      console.error('DELETE /api/user-challenges/:id error:', err);
      res.status(500).json({ message: 'Failed to leave challenge', error: err.message });
    }
  });

  /* -------------------------
     TIPS
  ------------------------- */

  // get tips (limit optional)
  app.get('/api/tips', async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 5;
      const items = await tipsCollection.find().sort({ createdAt: -1 }).limit(limit).toArray();
      res.json({ items });
    } catch (err) {
      console.error('GET /api/tips error:', err);
      res.status(500).json({ message: 'Failed to get tips', error: err.message });
    }
  });

  // get single tip
  app.get('/api/tips/:id', async (req, res) => {
    try {
      const id = req.params.id;
      let query;
      if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) query = { _id: new ObjectId(id) };
      else query = { _id: id };
      const tip = await tipsCollection.findOne(query);
      if (!tip) return res.status(404).json({ message: 'Tip not found' });
      res.json(tip);
    } catch (err) {
      console.error('GET /api/tips/:id error:', err);
      res.status(500).json({ message: 'Failed to get tip', error: err.message });
    }
  });

  // add tip
  app.post('/api/tips', async (req, res) => {
    try {
      const body = req.body || {};
      const newTip = {
        title: String(body.title || ''),
        content: String(body.content || ''),
        category: String(body.category || ''),
        author: String(body.author || ''),
        authorName: String(body.authorName || ''),
        upvotes: Number(body.upvotes) || 0,
        createdAt: new Date(),
      };
      const result = await tipsCollection.insertOne(newTip);
      res.status(201).json({ success: true, tipId: result.insertedId, tip: { _id: result.insertedId, ...newTip } });
    } catch (err) {
      console.error('POST /api/tips error:', err);
      res.status(500).json({ message: 'Failed to create tip', error: err.message });
    }
  });

  // upvote tip
  app.patch('/api/tips/:id/upvote', async (req, res) => {
    try {
      const id = req.params.id;
      let query;
      if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) query = { _id: new ObjectId(id) };
      else query = { _id: id };

      const result = await tipsCollection.updateOne(query, { $inc: { upvotes: 1 } });
      res.json({ success: true, modifiedCount: result.modifiedCount });
    } catch (err) {
      console.error('PATCH /api/tips/:id/upvote error:', err);
      res.status(500).json({ message: 'Failed to upvote tip', error: err.message });
    }
  });

  // delete tip (optional)
  app.delete('/api/tips/:id', async (req, res) => {
    try {
      const id = req.params.id;
      let query;
      if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) query = { _id: new ObjectId(id) };
      else query = { _id: id };
      const result = await tipsCollection.deleteOne(query);
      res.json({ success: true, deletedCount: result.deletedCount });
    } catch (err) {
      console.error('DELETE /api/tips/:id error:', err);
      res.status(500).json({ message: 'Failed to delete tip', error: err.message });
    }
  });

  /* -------------------------
     EVENTS
  ------------------------- */

  // get events (upcoming option & limit)
  app.get('/api/events', async (req, res) => {
    try {
      const now = new Date();
      const upcoming = req.query.upcoming === 'true';
      const limit = Number(req.query.limit) || 4;
      const q = upcoming ? { date: { $gte: now } } : {};
      const items = await eventsCollection.find(q).sort({ date: 1 }).limit(limit).toArray();
      res.json({ items });
    } catch (err) {
      console.error('GET /api/events error:', err);
      res.status(500).json({ message: 'Failed to get events', error: err.message });
    }
  });

  // get single event
  app.get('/api/events/:id', async (req, res) => {
    try {
      const id = req.params.id;
      let query;
      if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) query = { _id: new ObjectId(id) };
      else query = { _id: id };
      const ev = await eventsCollection.findOne(query);
      if (!ev) return res.status(404).json({ message: 'Event not found' });
      res.json(ev);
    } catch (err) {
      console.error('GET /api/events/:id error:', err);
      res.status(500).json({ message: 'Failed to get event', error: err.message });
    }
  });

  // create event
  app.post('/api/events', async (req, res) => {
    try {
      const body = req.body || {};
      const required = ['title', 'description', 'date', 'location', 'organizer', 'maxParticipants'];
      for (const f of required) {
        if (!body[f]) return res.status(400).json({ message: `${f} is required` });
      }

      const newEvent = {
        title: String(body.title),
        description: String(body.description),
        date: new Date(body.date),
        location: String(body.location),
        organizer: String(body.organizer),
        maxParticipants: Number(body.maxParticipants) || 0,
        currentParticipants: Number(body.currentParticipants) || 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await eventsCollection.insertOne(newEvent);
      res.status(201).json({ success: true, eventId: result.insertedId, event: { _id: result.insertedId, ...newEvent } });
    } catch (err) {
      console.error('POST /api/events error:', err);
      res.status(500).json({ message: 'Failed to create event', error: err.message });
    }
  });

  /* -------------------------
     USERS
  ------------------------- */

  // create user (idempotent)
  app.post('/api/users', async (req, res) => {
    try {
      const user = req.body || {};
      if (!user.email) return res.status(400).json({ message: 'email is required' });
      const existingUser = await usersCollection.findOne({ email: user.email });
      if (existingUser) return res.json({ message: 'User already exists', user: existingUser });

      const newUser = {
        ...user,
        role: user.role || 'user',
        ecoPoints: Number(user.ecoPoints) || 0,
        createdAt: new Date(),
      };

      const result = await usersCollection.insertOne(newUser);
      res.status(201).json({ success: true, userId: result.insertedId, user: newUser });
    } catch (err) {
      console.error('POST /api/users error:', err);
      res.status(500).json({ message: 'Failed to create user', error: err.message });
    }
  });

  // get all users
  app.get('/api/users', async (req, res) => {
    try {
      const items = await usersCollection.find().toArray();
      res.json(items);
    } catch (err) {
      console.error('GET /api/users error:', err);
      res.status(500).json({ message: 'Failed to get users', error: err.message });
    }
  });

  // get single user by email
  app.get('/api/users/:email', async (req, res) => {
    try {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      if (!user) return res.status(404).json({ message: 'User not found' });
      res.json(user);
    } catch (err) {
      console.error('GET /api/users/:email error:', err);
      res.status(500).json({ message: 'Failed to get user', error: err.message });
    }
  });

  // update user by email
  app.patch('/api/users/:email', async (req, res) => {
    try {
      const email = req.params.email;
      const updatedData = req.body || {};
      delete updatedData.email;
      const result = await usersCollection.updateOne({ email }, { $set: updatedData });
      res.json({ success: true, modifiedCount: result.modifiedCount });
    } catch (err) {
      console.error('PATCH /api/users/:email error:', err);
      res.status(500).json({ message: 'Failed to update user', error: err.message });
    }
  });

  /* -------------------------
     STATS
  ------------------------- */

  app.get('/api/stats', async (req, res) => {
    try {
      const [totalChallenges, totalTips, totalEvents, totalUsers] = await Promise.all([
        challengesCollection.countDocuments({}),
        tipsCollection.countDocuments({}),
        eventsCollection.countDocuments({}),
        usersCollection.countDocuments({}),
      ]);

      const uniqAgg = await userChallengesCollection.aggregate([
        { $match: { status: 'Ongoing' } },
        { $group: { _id: null, users: { $addToSet: '$userId' } } },
        { $project: { count: { $size: '$users' } } }
      ]).toArray();
      const activeParticipants = (uniqAgg[0] && uniqAgg[0].count) || 0;

      const sumAgg = await userChallengesCollection.aggregate([
        { $unwind: { path: '$progressLogs', preserveNullAndEmptyArrays: false } },
        { $group: { _id: null, totalValue: { $sum: { $toDouble: '$progressLogs.value' } } } }
      ]).toArray();
      const totalPlasticReducedKg = (sumAgg[0] && sumAgg[0].totalValue) || 0;

      res.json({
        totalChallenges,
        totalTips,
        totalEvents,
        totalUsers,
        activeParticipants,
        totalPlasticReducedKg,
      });
    } catch (err) {
      console.error('GET /api/stats error:', err);
      res.status(500).json({ message: 'Failed to compute stats', error: err.message });
    }
  });

  // (Optional) Print registered routes for debugging (cold-start only)
  try {
    if (app._router && app._router.stack) {
      const routes = app._router.stack
        .filter(r => r.route && r.route.path)
        .map(r => {
          const methods = Object.keys(r.route.methods).join(',').toUpperCase();
          return `${methods} ${r.route.path}`;
        });
      console.log('Registered routes:\n', routes.join('\n'));
    }
  } catch (e) {
    // ignore
  }
}

// ensure routes attached before handling any request
app.use(async (req, res, next) => {
  try {
    await attachRoutes();
    return next();
  } catch (err) {
    console.error('Error attaching routes:', err);
    return res.status(500).json({ message: 'Server startup error', error: err.message });
  }
});

// 404 & global error handlers
app.use((req, res) => res.status(404).json({ message: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({ message: 'Something went wrong', error: err?.message });
});

// Export serverless handler
module.exports = serverless(app);
