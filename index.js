const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());

const uri = "mongodb+srv://eco-track_user:hLGaFuHZl7B2wGud@cluster0.9lf33xm.mongodb.net/?appName=Cluster0";

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

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

    //  GET all challenges
    app.get('/api/challenges', async (req, res) => {
      const result = await challengesCollection.find().toArray();
      res.send(result);
    });

    //  GET single challenge by ID
    app.get('/api/challenges/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await challengesCollection.findOne(query);
      res.send(result);
    });

    // POST new challenge
    app.post('/api/challenges', async (req, res) => {
      const newChallenge = req.body;
      const result = await challengesCollection.insertOne(newChallenge);
      res.send(result);
    });

    // PATCH (update) challenge by ID
    app.patch('/api/challenges/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const updatedData = req.body;
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: updatedData
        };

        const result = await challengesCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Error updating challenge', error });
      }
    });

    //  DELETE challenge
    app.delete('/api/challenges/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await challengesCollection.deleteOne(query);
      res.send(result);
    });

    // Get all tips 
     app.get("/api/tips", async (req, res) => { const result = await tipsCollection.find().sort({ createdAt: -1 }).toArray(); res.send(result); });


     app.get("/api/tips/:id", async (req, res) => {
      const id = req.params.id;
      const result = await tipsCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

   app.get("/api/events", async (req, res) => {
      const now = new Date();
      const result = await eventsCollection
        .find({ date: { $gte: now } })
        .sort({ date: 1 }).toArray();
      res.send(result);
    });

     app.get("/api/events/:id", async (req, res) => {
      const id = req.params.id;
      const result = await eventsCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.post("/api/users", async (req, res) => {
  const user = req.body;

  // check if user already exists
  const existingUser = await usersCollection.findOne({ email: user.email });
  if (existingUser) {
    return res.send({ message: "User already exists", user: existingUser });
  }

  const newUser = {
    ...user,
    role: "user",
    ecoPoints: 0,
    createdAt: new Date(),
  };
  const result = await usersCollection.insertOne(newUser);
  res.send(result);
});

app.get("/api/users", async (req, res) => {
  const result = await usersCollection.find().toArray();
  res.send(result);
});

// ✅ Get a single user by email
app.get("/api/users/:email", async (req, res) => {
  const email = req.params.email;
  const user = await usersCollection.findOne({ email });
  res.send(user);
});

app.patch("/api/users/:email", async (req, res) => {
  const email = req.params.email;
  const updatedData = req.body;
  const result = await usersCollection.updateOne(
    { email },
    { $set: updatedData }
  );
  res.send(result);
});



    await client.db("admin").command({ ping: 1 });
    console.log("✅ Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // await client.close();
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`🚀 server running on port: ${port}`);
});
