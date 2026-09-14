function blockIfBanned(req, res, next) {
  const user = req.user;
  if (user && user.account_status === 'banned') {
    return res.status(403).json({
      error: 'account_banned',
      ban_expires_at: user.ban_expires_at,
      message: 'Your account is suspended for 21 days due to multiple reports.'
    });
  }
  next();
}

module.exports = { blockIfBanned };
