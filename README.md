# MilongaApp - AI-Powered Tango Milonga Planner

A sophisticated web application for planning and managing tango milongas (social dance events) using AI-powered music curation and real-time streaming capabilities.

## 🎯 Overview

MilongaApp is a single-page application that helps DJs and organizers create structured playlists for tango milongas. It uses AI agents to automatically curate tandas (sets of 3-4 songs) and cortinas (brief interludes between sets) based on musical analysis, traditional milonga programming patterns, and DJ preferences.

## ✨ Key Features

- **AI-Powered Planning**: Uses OpenAI GPT-4 agents to intelligently select tracks based on musical compatibility, era, orchestra, and energy flow
- **Real-time Streaming**: Direct audio streaming with range request support for efficient playback
- **Interactive Timeline**: Visual timeline interface for managing tandas and cortinas with drag-and-drop functionality
- **Music Analysis**: Automatic BPM, key, energy analysis and musical metadata enrichment
- **Tanda Library**: Save and reuse favorite tanda combinations
- **Smart Replacements**: One-click track replacement with AI-powered suggestions
- **Multiple Planning Modes**: Choose from different milonga styles (Classic, Modern, Rich, Alternative)
- **Playlist Persistence**: Save, load, and manage complete milonga plans

## 🏗️ Architecture

### Backend (Node.js + Express)

The server (`server.js`) provides:

- **Music Library Management**: Loads and serves music catalogs from JSON files
- **AI Agent Integration**: OpenAI-powered planning and replacement agents
- **Audio Streaming**: Efficient file streaming with HTTP range support
- **RESTful API**: Comprehensive endpoints for catalog, planning, and playlist management
- **Real-time Communication**: NDJSON streaming for live plan generation

### Frontend (Vanilla JavaScript SPA)

The client (`public/index.html`) features:

- **Interactive Timeline**: Visual representation of the complete milonga plan
- **Audio Player**: Built-in HTML5 audio player with progress tracking
- **Live Planning**: Real-time display of AI-generated tandas as they're created
- **Replacement Interface**: Click-to-replace functionality with AI suggestions
- **Activity Logging**: Real-time activity and LLM transcript viewing

### AI Agents (`agent/` directory)

- **Orchestra Agent**: Selects appropriate orchestras based on style and role
- **Planning Agent**: Creates complete milonga plans with proper flow
- **Replacement Agent**: Finds suitable track replacements maintaining musical coherence
- **Scoring System**: Evaluates track compatibility based on multiple musical factors

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ (uses ES modules)
- OpenAI API key (GPT-4 access required)
- Music library in supported formats (MP3, M4A, FLAC, etc.)
- Pre-processed music catalog JSON file

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd MilongaApp
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   # Create .env file
   echo "OPENAI_API_KEY=your-openai-api-key-here" > .env
   echo "PORT=4000" >> .env
   echo "LIBRARY_JSON=./catalog-Art.json" >> .env
   ```

4. **Prepare your music catalog**
   - Place your music catalog JSON file (e.g., `catalog-Art.json`) in the root directory
   - Ensure the catalog contains enriched metadata (BPM, key, energy, etc.)
   - Update file paths in `server.js` to match your music directory structure

5. **Start the server**
   ```bash
   npm start
   ```

6. **Open the application**
   Navigate to `http://localhost:4000` in your browser

## 📁 Project Structure

```
MilongaApp/
├── server.js              # Express server and API routes
├── generate.js            # AI agent orchestration and planning logic
├── dj-lib.js             # Shared music library utilities
├── package.json          # Node.js dependencies and scripts
├── agent/                # AI agent implementations
│   ├── orchestraAgent.js # Orchestra selection logic
│   ├── replacementAgent.js # Track replacement logic
│   └── scoring.js        # Musical compatibility scoring
├── public/               # Frontend assets
│   ├── index.html        # Main SPA interface
│   ├── style.css         # Application styling
│   └── viewer.html       # Now playing viewer window
├── schemas/              # Zod validation schemas
│   └── nextOrchestras.js # Orchestra selection schema
├── playlists/            # Saved playlist storage
├── tandas/              # Tanda library storage
└── favicon_io/          # Application icons
```

## 🎵 Music Catalog Format

The application expects a JSON catalog with enriched track metadata:

```json
{
  "tracks": [
    {
      "file": {
        "absPath": "/path/to/music/artist/album/track.mp3",
        "absolutePath": "/path/to/music/artist/album/track.mp3"
      },
      "tags": {
        "title": "El Choclo",
        "artist": "Ángel D'Agostino",
        "album": "Tango Collection",
        "genre": ["Tango"],
        "year": 1941,
        "BPM": 118.5,
        "Energy": 0.72,
        "Key": "Gm",
        "camelotKey": "6A",
        "coverUrl": "/path/to/album/art.jpg"
      },
      "format": {
        "durationSec": 186.3
      }
    }
  ]
}
```

## 🎛️ API Reference

### Core Endpoints

- **GET** `/api/catalog/compact` - Paginated track catalog with filtering
- **GET** `/api/catalog/full` - Complete track catalog
- **POST** `/api/agent/generate/ndjson` - Stream AI-generated milonga plan
- **POST** `/api/agent/replace` - Replace track with AI suggestions
- **GET/POST/DELETE** `/api/playlists` - Playlist management
- **GET/POST/DELETE** `/api/tandas` - Tanda library management
- **GET** `/stream/:id` - Audio file streaming

### Planning Parameters

```javascript
{
  "minutes": 180,           // Target duration
  "pattern": ["Tango", "Tango", "Vals", "Tango", "Tango", "Milonga"],
  "sizes": {                // Tracks per tanda
    "Tango": 4,
    "Vals": 3,
    "Milonga": 3
  },
  "catalog": {...}          // Music catalog
}
```

## 🎭 Milonga Planning Concepts

### Tandas
Sets of 3-4 musically compatible songs, typically:
- Same orchestra or era
- Similar BPM and energy level
- Compatible musical keys
- Coherent emotional arc

### Cortinas
Brief musical interludes (30-90 seconds) between tandas:
- Non-tango music (jazz, pop, classical)
- Clear sonic separation from tango
- Time for dancers to change partners

### Traditional Patterns
- **T-T-V-T-T-M**: Classic sequence (Tango-Tango-Vals-Tango-Tango-Milonga)
- **Roles**: Classic, Rich, Modern, Alternative orchestra selections
- **Energy Flow**: Gradual build-up and release throughout the evening

## 🔧 Configuration

### Environment Variables

```bash
PORT=4000                          # Server port
LIBRARY_JSON=./catalog-Art.json    # Path to music catalog
CORTINAS_DIR=/path/to/cortinas     # Directory for cortina files
PLAYLISTS_DIR=./playlists          # Playlist storage directory
TANDAS_DIR=./tandas               # Tanda library directory
OPENAI_API_KEY=sk-...             # OpenAI API key
```

### Music Directory Structure

```
/Users/johnwilliams/Music/MyMusic/
├── ROCK Artists/
├── Tango Artists/
│   ├── Carlos Di Sarli/
│   ├── Juan D'Arienzo/
│   └── Aníbal Troilo/
└── Art/                          # Album artwork
    └── covers/
```

## 🚀 Usage Guide

### Creating a New Milonga Plan

1. **Load Music Catalog**: Ensure your catalog is properly loaded (check browser console)

2. **Select Planning Style**: Choose from the schedule dropdown:
   - Standard: Balanced traditional programming
   - Classic: Golden Age orchestras focus
   - Modern: Contemporary and nuevo tango
   - Rich: Sophisticated, complex arrangements

3. **Set Parameters**:
   - Target duration (150, 180, 210 minutes)
   - Tango/Vals/Milonga preferences

4. **Generate Plan**:
   - **"Generate Tandas (stream)"**: Real-time AI generation with live updates
   - **"Agent Bulk Generator"**: Complete plan generation in one request

5. **Review and Adjust**:
   - Click tracks to play/preview
   - Use "✕" button to replace individual tracks
   - Use "↻ Retry" to regenerate entire tandas
   - Use "Select" to swap tanda positions

### Managing Your Library

#### Tanda Library
- **Save**: Click "💾 Save" on any tanda to add to library
- **Load**: Click "📂 Load" to replace current tanda with library version
- **Delete**: Use tanda dropdown and delete button

#### Playlists
- **Save**: Enter name and click "Save" to store complete milonga
- **Load**: Select from dropdown and click "Load"
- **Delete**: Select playlist and click "Delete"

### Live Performance

1. **Start Playback**: Click any track to begin
2. **Monitor Progress**: Watch "Now Playing" panel for current track info
3. **Auto-Advance**: Player automatically moves through tanda tracks
4. **Manual Control**: Use "Next Track" and "Play/Pause" buttons
5. **Time Tracking**: Monitor elapsed time and estimated end time

## 🎨 Customization

### Adding New Orchestra Profiles

Edit `agent/orchestraAgent.js` to add new orchestras:

```javascript
const ORCHESTRA_PROFILES = {
  "New Orchestra": {
    name: "New Orchestra",
    leader: "Orchestra Leader",
    period: [1940, 1950],
    style: "classic",
    characteristics: ["energetic", "rhythmic"],
    // ... other properties
  }
};
```

### Custom Scoring Algorithms

Modify `agent/scoring.js` to adjust track compatibility scoring:

```javascript
export function scoreTrackByRole(track, role, tandaSoFar = []) {
  // Custom scoring logic
  let score = 0;
  
  // Add your scoring criteria
  if (matchesEra(track, role)) score += 60;
  if (matchesOrchestra(track, role)) score += 40;
  
  return score;
}
```

## 🐛 Troubleshooting

### Common Issues

1. **Catalog Not Loading**
   - Check file path in `LIBRARY_JSON` environment variable
   - Verify JSON format is valid
   - Ensure file permissions allow reading

2. **Audio Not Playing**
   - Verify music file paths in catalog are absolute and correct
   - Check browser console for network errors
   - Ensure file formats are supported by browser

3. **AI Generation Failures**
   - Verify OpenAI API key is valid and has GPT-4 access
   - Check network connectivity
   - Monitor rate limits

4. **Empty Search Results**
   - Verify track `genre` tags match filter criteria ("Tango", "Vals", "Milonga")
   - Check that BPM and other metadata is properly formatted

### Debug Mode

Enable verbose logging by opening browser console and setting:

```javascript
// In browser console
localStorage.setItem('debug', 'true');
```

## 📊 Performance Optimization

### Catalog Size Management
- Use pagination for large catalogs (500+ tracks per page)
- Implement search/filtering to reduce active dataset
- Consider separate catalogs for different styles

### Audio Streaming
- Server implements HTTP range requests for efficient streaming
- Browser caches audio segments automatically
- Use appropriate bitrates for balance of quality/bandwidth

### AI Request Optimization
- Batch multiple planning requests when possible
- Use streaming endpoints for real-time feedback
- Implement request queuing for multiple simultaneous users

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Use ES modules throughout
- Follow existing code style and patterns
- Add JSDoc comments for new functions
- Test with various catalog sizes and formats
- Ensure backward compatibility with existing saved playlists

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- **Tango Community**: For traditional milonga programming wisdom
- **OpenAI**: For powerful language models enabling intelligent music curation
- **music-metadata**: For robust audio file analysis
- **Express.js**: For solid web framework foundation

## 📞 Support

For issues, questions, or contributions:

1. Check existing GitHub issues
2. Create new issue with detailed description
3. Include console logs and relevant configuration
4. Specify browser and Node.js versions

---

*¡Que disfruten el tango!* 🎵💃🕺