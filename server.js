require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const app = express();

// Configure CORS properly
app.use(cors({
  origin: '*', // In production, replace with specific domains
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// For preflight requests
app.options('*', cors());

// Parse JSON requests
app.use(express.json());

// Initialize Razorpay with your keys
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || '',
  key_secret: process.env.RAZORPAY_KEY_SECRET || ''
});

// Root endpoint with API information
app.get('/', (req, res) => {
  res.json({
    name: 'PostSync Payment API',
    status: 'online',
    endpoints: {
      health: '/health',
      razorpayOrder: '/api/razorpay-order',
      razorpayVerify: '/api/razorpay-verify'
    },
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    razorpayInitialized: !!razorpay
  });
});

// Create Razorpay order endpoint
app.post('/api/razorpay-order', async (req, res) => {
  try {
    const { amount, orderId, currency = 'INR', notes = {} } = req.body;
    
    if (!amount) {
      return res.status(400).json({ success: false, error: 'Amount is required' });
    }
    
    const options = {
      amount: amount * 100, // Razorpay expects amount in paisa
      currency,
      receipt: orderId,
      notes
    };
    
    console.log('Creating Razorpay order with options:', JSON.stringify(options));
    const order = await razorpay.orders.create(options);
    console.log('Razorpay order created:', JSON.stringify(order));
    
    res.json({ success: true, data: order });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create order',
      details: error.message || 'Unknown error'
    });
  }
});

// Verify Razorpay payment endpoint
app.post('/api/razorpay-verify', (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature 
    } = req.body;
    
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }
    
    // Verify the payment signature
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    
    const isSignatureValid = generatedSignature === razorpay_signature;
    
    if (!isSignatureValid) {
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }
    
    res.json({ success: true, message: 'Payment verified successfully' });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to verify payment',
      details: error.message || 'Unknown error'
    });
  }
});

// Test endpoint for CORS
app.get('/test-cors', (req, res) => {
  console.log('CORS test request received');
  console.log('Origin:', req.headers.origin);
  
  res.json({
    message: 'CORS test successful',
    headers: {
      allowOrigin: res.getHeader('Access-Control-Allow-Origin'),
      allowMethods: res.getHeader('Access-Control-Allow-Methods'),
      allowHeaders: res.getHeader('Access-Control-Allow-Headers')
    },
    requestHeaders: req.headers
  });
});

// Add a new endpoint to your server.js
app.post('/api/update-user-credits', async (req, res) => {
  try {
    const { 
      userId, 
      plan, 
      credits,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature 
    } = req.body;
    
    // 1. Verify payment signature first
    if (razorpay_signature === 'upi_payment') {
      // Skip signature verification for UPI payments
      isSignatureValid = true;
    } else {
      const generatedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');
      
      const isSignatureValid = generatedSignature === razorpay_signature;
      
      if (!isSignatureValid) {
        return res.status(400).json({ success: false, error: 'Invalid signature' });
      }
    }
    
    // 2. Update user credits in Firebase (using admin SDK)
    const admin = require('firebase-admin');
    
    // Initialize Firebase Admin if not already initialized
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
      });
    }
    
    const db = admin.firestore();
    const userRef = db.collection('users').doc(userId);
    
    // Get current user data
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const userData = userDoc.data();
    const currentCredits = userData.credits || 0;
    
    // Calculate amount based on plan
    const amount = plan === 'basic' ? 1 : plan === 'starter' ? 499 : 1499;
    
    // Update user data
    await userRef.update({
      credits: currentCredits + credits,
      'plan.imagesGenerated': admin.firestore.FieldValue.increment(0),
      'plan.name': plan,
      'plan.purchasedAt': new Date().toISOString(),
      'plan.purchaseHistory': admin.firestore.FieldValue.arrayUnion({
        date: new Date().toISOString(),
        plan: plan,
        credits: credits,
        amount: amount,
        paymentMethod: 'razorpay',
        transactionId: razorpay_payment_id,
        orderId: razorpay_order_id
      })
    });
    
    res.json({ 
      success: true, 
      message: 'Payment verified and credits updated successfully',
      newCredits: currentCredits + credits
    });
  } catch (error) {
    console.error('Error updating user credits:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update user credits',
      details: error.message || 'Unknown error'
    });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 
