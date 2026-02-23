import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'email';
const COLLECTION_NAME = 'email';

let client = null;
let db = null;

export async function connectMongoDB() {
  if (client && db) {
    return { client, db };
  }

  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);

    console.log(
      `${new Date().toISOString()}-Successfully connected to MongoDB: ${DB_NAME}`,
    );

    // Create index on email address for faster lookups
    // await db.collection(COLLECTION_NAME).createIndex({ address: 1 }, { unique: true });

    return { client, db };
  } catch (error) {
    console.error(
      `${new Date().toISOString()}-Error connecting to MongoDB:`,
      error.message,
    );
    throw error;
  }
}

export async function updateEmailExpiry(emailAddress, expiryDate) {
  try {
    const { db } = await connectMongoDB();
    const collection = db.collection(COLLECTION_NAME);

    const result = await collection.updateOne(
      { address: emailAddress },
      {
        $set: {
          expiryDate: expiryDate,
          lastSignDate: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          urgency: 0,
        },
      },
    );

    console.log(
      `${new Date().toISOString()}-Updated expiry date for email: ${emailAddress}`,
    );
    return result;
  } catch (error) {
    console.error(
      `${new Date().toISOString()}-Error updating email expiry:`,
      error.message,
    );
    throw error;
  }
}

export async function closeMongoDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log(`${new Date().toISOString()}-MongoDB connection closed`);
  }
}
