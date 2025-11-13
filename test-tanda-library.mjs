#!/usr/bin/env node

// Simple test for tanda library endpoints

const testTanda = {
  name: "Test Tanda - Di Sarli Magic",
  tanda: {
    orchestra: "Carlos di Sarli",
    style: "Tango",
    tracks: [
      { 
        id: "test1", 
        title: "La Cumparsita", 
        artist: "Carlos di Sarli",
        BPM: 120,
        seconds: 180,
        camelotKey: "5A"
      },
      { 
        id: "test2", 
        title: "El Choclo", 
        artist: "Carlos di Sarli",
        BPM: 118,
        seconds: 175,
        camelotKey: "5A"
      },
      { 
        id: "test3", 
        title: "Bahía Blanca", 
        artist: "Carlos di Sarli",
        BPM: 122,
        seconds: 190,
        camelotKey: "5A"
      }
    ]
  }
};

async function testTandaLibrary() {
  try {
    console.log("🧪 Testing tanda library endpoints...");
    
    // Test save tanda
    console.log("📝 Saving test tanda...");
    const saveResponse = await fetch('http://localhost:4000/api/tandas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testTanda)
    });

    if (!saveResponse.ok) {
      throw new Error(`Save failed: ${saveResponse.status} ${saveResponse.statusText}`);
    }

    const saveResult = await saveResponse.json();
    console.log("✅ Save success:", saveResult);
    
    // Test list tandas
    console.log("📋 Listing tandas...");
    const listResponse = await fetch('http://localhost:4000/api/tandas');
    const listResult = await listResponse.json();
    console.log("✅ List success:", listResult);
    
    if (listResult.tandas && listResult.tandas.length > 0) {
      const tandaId = listResult.tandas[0].id;
      
      // Test get specific tanda
      console.log(`🔍 Getting tanda ${tandaId}...`);
      const getResponse = await fetch(`http://localhost:4000/api/tandas/${tandaId}`);
      const getResult = await getResponse.json();
      console.log("✅ Get success:", getResult.name, `(${getResult.tanda.tracks.length} tracks)`);
      
      console.log("🎉 All tanda library endpoints working!");
    }

  } catch (error) {
    console.error("💥 Test failed:", error.message);
  }
}

testTandaLibrary();