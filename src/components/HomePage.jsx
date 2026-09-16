import { useState } from 'react';
import { Trophy, Users, Calendar, Code, Rocket, Award, ChevronRight, Calendar as CalendarIcon, Link } from 'lucide-react';

const heroStats = [
  { icon: Trophy, label: 'FRC Team', value: '5728', color: '#a16207' },
  { icon: CalendarIcon, label: 'Meetings', value: 'Wednesdays and Thursdays', color: '#166534', link: '#meetings' },
  { icon: Award, label: 'Rookie Year', value: '2015', color: '#92400e' },
];

const features = [
  {
    icon: Code,
    title: 'Robot Programming',
    description: 'Build autonomous routines and driver control systems. Work with Java, camera vision, and sensor integration.'
  },
  {
    icon: Trophy,
    title: 'Compete in FRC',
    description: 'Join district competitions across California. In 2026, we made playoffs for the first time!'
  },
  {
    icon: Users,
    title: 'Teamwork & Leadership',
    description: 'Collaborate with drivers, strategists, and pit crew. Practice gracious professionalism and communication.'
  },
  {
    icon: Rocket,
    title: 'Mechanical Build',
    description: 'Design, fabricate, and assemble competition robots. 2026 featured our first Swerve Drive system.'
  },
  {
    icon: Award,
    title: 'Grow Your Skills',
    description: 'Develop engineering thinking, problem-solving, and project management skills used in college and careers.'
  },
  {
    icon: CalendarIcon,
    title: 'Build Season',
    description: '6 weeks of intense building in January-February. Weekly meetings year-round to prepare for competition.'
  },
];

const stats = [
  { label: 'Playoff Appearances', value: '2' },
  { label: '2026 Wins', value: '7' },
  { label: 'Swerve Drive', value: '2026' },
  { label: 'District Rank', value: '#259' },
];

export default function HomePage() {
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      {/* Hero Section */}
      <section className="relative overflow-hidden px-4 sm:px-6 py-14 sm:py-24 lg:py-32">
        <div className="max-w-7xl mx-auto relative z-10">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold mb-6 rim-gold"
                   style={{ color: 'var(--gold)' }}>
                <span className="w-2 h-2 rounded-full" style={{ background: '#ffc72c' }}></span>
                Team 5728 - MCHS Robotics
              </div>
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold mb-6 leading-tight"
                  style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                From Rookie to<br />
                <span style={{ color: '#15803d' }}>Playoff Contender</span>
              </h1>
              <p className="text-lg sm:text-xl text-gray-400 mb-8 max-w-xl">
                MC2 - Team 5728 is a FIRST Robotics Competition team that made playoffs in 2026 after years of steady growth. We build competitive robots and develop real-world engineering skills.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
                <a href="#features" className="btn-school px-6 py-3 rounded-lg font-semibold text-center justify-center">
                  Get Involved
                </a>
                <a href="https://mchsrobotics.dev" target="_blank" rel="noopener noreferrer"
                   className="px-6 py-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2"
                   style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                   onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-light)'; }}
                   onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}>
                  Visit Our Website <ChevronRight className="w-4 h-4" />
                </a>
              </div>
            </div>

            <div className="relative max-w-xs mx-auto sm:max-w-none">
              <div className="aspect-square rounded-2xl overflow-hidden"
                   style={{ background: '#ffffff', border: '1px solid var(--border)', boxShadow: '0 24px 48px rgba(29,36,25,0.12)' }}>
                <img src="/icon.svg" alt="Team 5728" className="w-full h-full object-cover" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="py-10 sm:py-16 px-4 sm:px-6 border-y" style={{ borderColor: 'var(--border)' }}>
        <div className="max-w-7xl mx-auto grid grid-cols-2 lg:grid-cols-4 gap-6 sm:gap-8">
          {stats.map((stat, i) => (
            <div key={i} className="text-center">
              <div className="text-3xl sm:text-4xl font-bold mb-2" style={{ color: 'var(--gold)' }}>{stat.value}</div>
              <div className="text-sm text-gray-400">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Stats Grid */}
      <section className="py-12 sm:py-20 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold mb-8 sm:mb-12 text-center" style={{ color: 'var(--text-primary)' }}>
            By the Numbers
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {heroStats.map((stat, i) => (
              <div key={i} className={`p-4 sm:p-6 rounded-xl text-center transition-all ${stat.link ? 'cursor-pointer hover:shadow-lg' : ''}`}
                   style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                   onMouseEnter={e => { if (stat.link) { e.currentTarget.style.borderColor = 'var(--text-subtle)'; } }}
                   onMouseLeave={e => { if (stat.link) { e.currentTarget.style.borderColor = 'var(--border)'; } }}
                   onClick={() => { if (stat.link) window.location.hash = stat.link.replace('#', ''); }}>
                <stat.icon className="w-8 h-8 sm:w-12 sm:h-12 mx-auto mb-3 sm:mb-4" style={{ color: stat.color }} />
                <div className="text-xl sm:text-3xl font-bold mb-1 sm:mb-2" style={{ color: 'var(--text-primary)' }}>{stat.value}</div>
                <div className="flex items-center justify-center gap-1.5 text-sm text-gray-400">
                  {stat.label}
                  {stat.link && <Link className="w-3.5 h-3.5" style={{ color: 'var(--text-subtle)' }} />}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-12 sm:py-20 px-4 sm:px-6" style={{ background: 'var(--bg-overlay)' }}>
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-10 sm:mb-16">
            <h2 className="text-2xl sm:text-3xl font-bold mb-4" style={{ color: 'var(--text-primary)' }}>
              What You'll Learn
            </h2>
            <p className="text-gray-400 max-w-2xl mx-auto">
              Our program provides hands-on experience in engineering, programming, and teamwork — all in a supportive environment.
            </p>
          </div>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature, i) => (
              <div key={i} className="p-5 sm:p-6 rounded-xl transition-all hover:shadow-lg"
                   style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
                   onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; }}
                   onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}>
                <feature.icon className="w-8 h-8 sm:w-10 sm:h-10 mb-3 sm:mb-4" style={{ color: '#16a34a' }} />
                <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{feature.title}</h3>
                <p className="text-sm text-gray-400">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Call to Action */}
      <section className="py-12 sm:py-20 px-4 sm:px-6">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-bold mb-6" style={{ color: 'var(--text-primary)' }}>
            Ready to Join the Team?
          </h2>
          <p className="text-lg text-gray-400 mb-8">
            Whether you're interested in programming, mechanical design, electrical work, or just want to learn — we have a place for you.
          </p>
          <a href="#chat" className="btn-school inline-flex items-center gap-2 px-6 py-3 sm:px-8 sm:py-4 rounded-lg font-bold text-base sm:text-lg">
            <Users className="w-5 h-5" />
            Join Our Team
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-10 sm:py-12 px-4 sm:px-6 border-t" style={{ borderColor: 'var(--border)' }}>
        <div className="max-w-7xl mx-auto">
          <div className="grid md:grid-cols-3 gap-8 mb-8">
            <div>
              <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>MCHS Robotics</h3>
              <p className="text-sm text-gray-400">
                FIRST Robotics Competition Team 5728<br />
                Maria Carrilo High School
              </p>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Quick Links</h3>
              <div className="space-y-2 text-sm">
                <a href="#features" className="text-gray-400 hover:text-green-800 transition-colors">What We Do</a>
                <a href="#chat" className="text-gray-400 hover:text-green-800 transition-colors">Join the Team</a>
                <a href="#faq" className="text-gray-400 hover:text-green-800 transition-colors">FAQ</a>
                <a href="#" onClick={(e) => { e.preventDefault(); window.location.hash = 'calendar'; }} className="text-gray-400 hover:text-green-800 transition-colors">Calendar</a>
                <a href="https://mchsrobotics.dev" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-green-800 transition-colors">Our Website</a>
              </div>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Connect</h3>
              <div className="space-y-2 text-sm">
                <a href="https://github.com/mchsrobotics" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-green-800 transition-colors">GitHub</a>
                <a href="https://instagram.com/mchsrobotics" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-green-800 transition-colors">Instagram</a>
                <a href="mailto:robotics@mchsrobotics.dev" className="text-gray-400 hover:text-green-800 transition-colors">Email Us</a>
              </div>
            </div>
          </div>
          <div className="pt-8 border-t" style={{ borderColor: 'var(--border)' }}>
            <p className="text-sm text-gray-500 text-center">
              © {new Date().getFullYear()} MCHS Robotics · Team 5728
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
