# Deep Research Codebase Analysis

## Project Overview
Deep Research is a modern web application built with Next.js 15 that leverages Google Gemini models to generate comprehensive research reports. The project is designed to be privacy-focused, with local data storage and processing capabilities.

## Technical Stack
- **Framework**: Next.js 15 with TypeScript
- **UI Components**: Shadcn UI (based on Radix UI)
- **Styling**: Tailwind CSS
- **State Management**: Zustand
- **Form Handling**: React Hook Form with Zod validation
- **Internationalization**: i18next
- **Markdown Editor**: Milkdown
- **Deployment Options**: Vercel, Cloudflare Pages, Docker

## Project Structure
```
src/
├── app/           # Next.js app router pages
├── components/    # Reusable UI components
├── constants/     # Application constants
├── hooks/         # Custom React hooks
├── locales/       # i18n translation files
├── store/         # Zustand state management
├── utils/         # Utility functions
├── middleware.ts  # Next.js middleware
└── types.d.ts     # TypeScript type definitions
```

## Key Features
1. **Research Generation**
   - Rapid report generation using Google Gemini models
   - Support for "Thinking" and "Flash" research models
   - Local data processing and storage

2. **User Interface**
   - Modern, responsive design using Shadcn UI
   - Dark/light theme support
   - Multi-language support (English, Simplified Chinese)

3. **Content Management**
   - Canvas-based content editing
   - WYSIWYM and Markdown editing modes
   - Research history preservation
   - Reading level and article length adjustment
   - Full text translation capabilities

4. **API Integration**
   - Support for both local and server-side API calls
   - Multi-key payload support
   - Configurable API proxy

## Development Setup
- Node.js ≥ 18.18.0 required
- Package manager: pnpm (recommended), npm, or yarn
- Environment variables for server-side API configuration:
  - `GOOGLE_GENERATIVE_AI_API_KEY`
  - `API_PROXY_BASE_URL`
  - `ACCESS_PASSWORD`
  - `HEAD_SCRIPTS`

## Deployment Options
1. **Vercel**: One-click deployment available
2. **Cloudflare Pages**: Custom deployment process
3. **Docker**: Containerized deployment with environment variable support
4. **Static Export**: Build to static files for any static hosting service

## Privacy & Security
- Local data storage and processing
- Optional server-side API configuration
- Password protection for server endpoints
- No data collection beyond API calls

## Future Roadmap
- [ ] File upload and local knowledge base support
- [ ] Additional LLM model integration
- [x] Research history preservation
- [x] Report editing capabilities

## Development Notes
- Uses Turbopack for development
- Implements modern React patterns and hooks
- Strong TypeScript typing throughout
- Comprehensive documentation available
- MIT licensed for both personal and commercial use

## Dependencies
Key dependencies include:
- Next.js 15
- React 19
- Tailwind CSS
- Shadcn UI components
- Zustand for state management
- i18next for internationalization
- Milkdown for markdown editing
- Various Radix UI primitives

## Build & Development Commands
- `pnpm dev`: Start development server with Turbopack
- `pnpm build`: Production build
- `pnpm build:docker`: Docker-specific build
- `pnpm build:export`: Static export build
- `pnpm start`: Start production server
- `pnpm lint`: Run linting 