#!/usr/bin/env node

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
      { 
        id: "test1", 
        title: "Test Track 1", 
        artist: "Pugliese",
        styles: ["Tango"],
        tags: { genre: "Tango" }
      },
      { 
        id: "test2", 
        title: "Test Track 2", 
        artist: "Canaro",
        styles: ["Tango"],
        tags: { genre: "Tango" }
      }
    ]
  }
};

try {
  console.log("🧪 Testing retry endpoint...");
  
  const response = await fetch('http://localhost:4000/api/agent/retryTanda', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testData)
  });

  console.log(`📡 Status: ${response.status}`);
  
  if (response.ok) {
    const result = await response.json();
    console.log("✅ Success:", JSON.stringify(result, null, 2));
  } else {
    const error = await response.text();
    console.log("❌ Error:", error);
  }
} catch (error) {
  console.error("💥 Fetch failed:", error.message);
}