import React from 'react'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import Bookshelf from './pages/Bookshelf'
import SeriesView from './pages/SeriesView'
import BookView from './pages/BookView'
import TierList from './pages/TierList'
import Import from './pages/Import'
import Discover from './pages/Discover'

const styles = {
  app: { minHeight: '100vh', background: '#0f0e0c' },
  nav: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '0 24px', height: '56px',
    background: '#1a1814', borderBottom: '1px solid #2a2822',
    position: 'sticky', top: 0, zIndex: 100
  },
  logo: { fontWeight: 700, fontSize: '18px', color: '#e8e4dc', marginRight: '16px', letterSpacing: '-0.5px' },
  link: {
    padding: '6px 14px', borderRadius: '6px', fontSize: '14px',
    color: '#9a9488', textDecoration: 'none', transition: 'all 0.15s'
  },
  activeLink: {
    padding: '6px 14px', borderRadius: '6px', fontSize: '14px',
    color: '#e8e4dc', textDecoration: 'none', background: '#2a2822'
  }
}

export default function App() {
  return (
    <BrowserRouter>
      <div style={styles.app}>
        <nav style={styles.nav}>
          <span style={styles.logo}>📚 My Shelf</span>
          {[
            ['/', 'Bookshelf'],
            ['/tiers', 'Tier List'],
            ['/discover', 'Discover'],
            ['/import', 'Import']
          ].map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}
              style={({ isActive }) => isActive ? styles.activeLink : styles.link}>
              {label}
            </NavLink>
          ))}
        </nav>
        <Routes>
          <Route path="/" element={<Bookshelf />} />
          <Route path="/series/:id" element={<SeriesView />} />
          <Route path="/book/:id" element={<BookView />} />
          <Route path="/tiers" element={<TierList />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/import" element={<Import />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
