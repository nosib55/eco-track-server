// server.js
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});


function requireAuth(req, res, next) {
  
  const userEmail = req.header('x-user-email') || null;
  if (!userEmail) {
    return res.status(401).json({ message: 'Unauthorized. Send x-user-email header for now.' });
  }
  req.user = { email: userEmail };
  next();
}

app.get('/', (req, res) => {
  res.send('server is running');
});

async function run() {
  try {
    await client.connect();
    const db = client.db("ecoTrackDB");

    // Collections
    const challengesCollection = db.collection('challenges');
    const tipsCollection = db.collection("tips");
    const eventsCollection = db.collection("events");
    const usersCollection = db.collection("users");
    const userChallengesCollection = db.collection("userChallenges"); 

   
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
        } = req.query;

        const q = {};

        if (category) {
          const arr = String(category).split(',').map(s => s.trim());
          q.category = { $in: arr };
        }
        if (startDate_gte) {
          q.startDate = { ...(q.startDate || {}), $gte: new Date(startDate_gte) };
        }
        if (endDate_lte) {
          q.endDate = { ...(q.endDate || {}), $lte: new Date(endDate_lte) };
        }
        if (participants_gte || participants_lte) {
          q.participants = {};
          if (participants_gte) q.participants.$gte = Number(participants_gte);
          if (participants_lte) q.participants.$lte = Number(participants_lte);
        }
        if (search) {
          const re = new RegExp(search, 'i');
          q.$or = [{ title: re }, { description: re }];
        }

        const skip = (Number(page) - 1) * Number(limit);
        const sortObj = {};
        if (sort) {
          
          if (sort.startsWith('-')) sortObj[sort.slice(1)] = -1;
          else sortObj[sort] = 1;
        } else {
          sortObj.createdAt = -1;
        }

        const cursor = challengesCollection.find(q).sort(sortObj).skip(skip).limit(Number(limit));
        const items = await cursor.toArray();
        const total = await challengesCollection.countDocuments(q);
        res.json({ items, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to get challenges', error: err.message });
      }
    });

   
    app.get('/api/challenges/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await challengesCollection.findOne(query);
        if (!result) return res.status(404).json({ message: 'Challenge not found' });
        res.json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to get challenge', error: err.message });
      }
    });

    
    app.post('/api/challenges', requireAuth, async (req, res) => {
      try {
        const body = req.body;

        
        const required = ['title', 'category', 'description', 'duration', 'target', 'imageUrl', 'startDate', 'endDate'];
        for (const f of required) {
          if (!body[f]) return res.status(400).json({ message: `${f} is required` });
        }
        
        if (new Date(body.endDate) <= new Date(body.startDate)) {
          return res.status(400).json({ message: 'endDate must be after startDate' });
        }

        const newChallenge = {
          title: body.title,
          category: body.category,
          description: body.description,
          duration: Number(body.duration),
          target: body.target,
          participants: 0,
          impactMetric: body.impactMetric || '',
          createdBy: req.user.email, // using requireAuth
          startDate: new Date(body.startDate),
          endDate: new Date(body.endDate),
          imageUrl: body.imageUrl,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await challengesCollection.insertOne(newChallenge);
        res.status(201).json({ success: true, challengeId: result.insertedId, challenge: newChallenge });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to create challenge', error: err.message });
      }
    });


    app.patch('/api/challenges/:id', requireAuth, async (req, res) => {
      try {
        const id = req.params.id;
        const updatedData = req.body;
        const filter = { _id: new ObjectId(id) };
        const existing = await challengesCollection.findOne(filter);
        if (!existing) return res.status(404).json({ message: 'Challenge not found' });

        if (existing.createdBy !== req.user.email) {
          return res.status(403).json({ message: 'Forbidden: only owner can update' });
        }

        updatedData.updatedAt = new Date();
        const updateDoc = { $set: updatedData };
        const result = await challengesCollection.updateOne(filter, updateDoc);
        res.json({ success: true, modifiedCount: result.modifiedCount });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Error updating challenge', error: error.message });
      }
    });

  
    app.delete('/api/challenges/:id', requireAuth, async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const existing = await challengesCollection.findOne(filter);
        if (!existing) return res.status(404).json({ message: 'Challenge not found' });
        if (existing.createdBy !== req.user.email) {
          return res.status(403).json({ message: 'Forbidden: only owner can delete' });
        }
        const result = await challengesCollection.deleteOne(filter);
        res.json({ success: true, deletedCount: result.deletedCount });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to delete challenge', error: err.message });
      }
    });

   
    app.post('/api/challenges/join/:id', requireAuth, async (req, res) => {
      try {
        const challengeId = req.params.id;
        const userEmail = req.user.email;

        // ensure challenge exists
        const challenge = await challengesCollection.findOne({ _id: new ObjectId(challengeId) });
        if (!challenge) return res.status(404).json({ message: 'Challenge not found' });

        // check if already joined
        const exists = await userChallengesCollection.findOne({ userId: userEmail, challengeId: new ObjectId(challengeId) });
        if (exists) return res.status(200).json({ message: 'Already joined', userChallenge: exists });

        const uc = {
          userId: userEmail,
          challengeId: new ObjectId(challengeId),
          status: 'Ongoing',
          progress: 0,
          progressLogs: [], 
          joinDate: new Date(),
          lastUpdated: new Date(),
        };
        const insertResult = await userChallengesCollection.insertOne(uc);

       
        await challengesCollection.updateOne(
          { _id: new ObjectId(challengeId) },
          { $inc: { participants: 1 } }
        );

        res.status(201).json({ success: true, userChallengeId: insertResult.insertedId, userChallenge: uc });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to join challenge', error: err.message });
      }
    });

    
    app.get('/api/user-challenges/me', requireAuth, async (req, res) => {
      try {
        const userEmail = req.user.email;
        const ucs = await userChallengesCollection.find({ userId: userEmail }).toArray();

 
        const populated = await Promise.all(ucs.map(async uc => {
          const ch = await challengesCollection.findOne({ _id: uc.challengeId });
          return { ...uc, challenge: ch };
        }));

        res.json(populated);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to fetch user challenges', error: err.message });
      }
    });

    
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
          // push to logs
          await userChallengesCollection.updateOne(
            { _id: new ObjectId(id) },
            { $push: { progressLogs: { date: new Date(), value: Number(addLogValue) } } }
          );
        }
        updates.lastUpdated = new Date();

        const result = await userChallengesCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updates }
        );

        const updated = await userChallengesCollection.findOne({ _id: new ObjectId(id) });
        res.json({ success: true, updated });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to update progress', error: err.message });
      }
    });

    
    app.delete('/api/user-challenges/:id', requireAuth, async (req, res) => {
      try {
        const id = req.params.id;
        const uc = await userChallengesCollection.findOne({ _id: new ObjectId(id) });
        if (!uc) return res.status(404).json({ message: 'Not found' });
        if (uc.userId !== req.user.email) return res.status(403).json({ message: 'Forbidden' });

        // delete record
        await userChallengesCollection.deleteOne({ _id: new ObjectId(id) });

        // decrement participants on challenge (guard > 0)
        await challengesCollection.updateOne(
          { _id: uc.challengeId, participants: { $gt: 0 } },
          { $inc: { participants: -1 } }
        );

        res.json({ success: true, message: 'Left challenge' });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to leave challenge', error: err.message });
      }
    });

    
    app.get("/api/tips", async (req, res) => {
      try {
        const limit = Number(req.query.limit) || 5;
        const result = await tipsCollection.find().sort({ createdAt: -1 }).limit(limit).toArray();
        res.json({ items: result });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to get tips', error: err.message });
      }
    });

    app.get("/api/tips/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await tipsCollection.findOne({ _id: new ObjectId(id) });
        res.json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to get tip', error: err.message });
      }
    });

    
    app.get("/api/events", async (req, res) => {
      try {
        const now = new Date();
        const upcoming = req.query.upcoming === 'true';
        const limit = Number(req.query.limit) || 4;
        const q = upcoming ? { date: { $gte: now } } : {};
        const result = await eventsCollection.find(q).sort({ date: 1 }).limit(limit).toArray();
        res.json({ items: result });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to get events', error: err.message });
      }
    });

    app.get("/api/events/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await eventsCollection.findOne({ _id: new ObjectId(id) });
        res.json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to get event', error: err.message });
      }
    });

    
    app.post("/api/users", async (req, res) => {
      try {
        const user = req.body;
        const existingUser = await usersCollection.findOne({ email: user.email });
        if (existingUser) {
          return res.json({ message: "User already exists", user: existingUser });
        }
        const newUser = {
          ...user,
          role: "user",
          ecoPoints: 0,
          createdAt: new Date(),
        };
        const result = await usersCollection.insertOne(newUser);
        res.json({ success: true, userId: result.insertedId, user: newUser });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to create user', error: err.message });
      }
    });

    app.get("/api/users", async (req, res) => {
      try {
        const result = await usersCollection.find().toArray();
        res.json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to get users', error: err.message });
      }
    });

    app.get("/api/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });
        res.json(user);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to get user', error: err.message });
      }
    });

    app.patch("/api/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const updatedData = req.body;
        const result = await usersCollection.updateOne({ email }, { $set: updatedData });
        res.json({ success: true, modifiedCount: result.modifiedCount });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to update user', error: err.message });
      }
    });

   
    app.get('/api/stats', async (req, res) => {
      try {
        // active participants
        const activeParticipants = await userChallengesCollection.distinct('userId', { status: 'Ongoing' });

        
        const pipeline = [
          { $unwind: { path: '$progressLogs', preserveNullAndEmptyArrays: false } },
          { $group: { _id: null, totalValue: { $sum: '$progressLogs.value' } } }
        ];
        const agg = await userChallengesCollection.aggregate(pipeline).toArray();
        const totalValue = agg[0]?.totalValue || 0;

       
        res.json({
          totalCO2Saved: 0, 
          totalPlasticReducedKg: totalValue, 
          activeParticipants: activeParticipants.length,
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to compute stats', error: err.message });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB!");
  } finally {
    // don't close client for long-running server
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`🚀 server running on port: ${port}`);
});
