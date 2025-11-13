#!/usr/bin/env node

// Simple test script for the retry tanda endpoint

const testRetryEndpoint = async () => {
  try {
    const testData = {
      tandaIndex: 0,
      currentTanda: {
        orchestra: "Di Sarli",
        style: "Tango", 
        trackCount: 4
      },
      avoidOrchestras: ["Di Sarli"],
      catalog: {
        tracks: [
          { id: "test1", title: "Test Track 1", styles: ["Tango"] },
          { id: "test2", title: "Test Track 2", styles: ["Tango"] }
        ]
      }
    };

    console.log("🧪 Testing retry tanda endpoint...");
    
    const response = await fetch('http://localhost:4000/api/agent/retryTanda', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testData)
    });

    console.log(`📡 Response status: ${response.status}`);
    
    const result = await response.json();
    console.log("📋 Response:", JSON.stringify(result, null, 2));

    if (result.success) {
      console.log("✅ Retry endpoint is working!");
    } else {
      console.log("❌ Retry endpoint returned error:", result.error);
    }

  } catch (error) {
    console.error("💥 Test failed:", error.message);
  }
};

testRetryEndpoint();