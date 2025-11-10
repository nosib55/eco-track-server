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
