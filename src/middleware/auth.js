import jwt from 'jsonwebtoken';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

export function checkSubscription(requiredTier = 'basic') {
  return (req, res, next) => {
    const tierLevels = { basic: 1, premium: 2 };
    const userLevel = tierLevels[req.user.subscription_tier] || 0;
    const requiredLevel = tierLevels[requiredTier] || 0;

    if (userLevel < requiredLevel) {
      return res.status(403).json({ 
        error: `${requiredTier} subscription required`,
        currentTier: req.user.subscription_tier 
      });
    }
    next();
  };
}
