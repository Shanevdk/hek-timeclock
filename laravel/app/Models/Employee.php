<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

/**
 * An employee is the user of this system — there is no separate account behind
 * them. Roles are coarse on purpose (see the employee_permissions migration):
 * the money rule they enforce has to be absolute.
 */
class Employee extends Authenticatable
{
    use HasFactory, Notifiable;

    protected $fillable = [
        'name', 'first_name', 'last_name', 'initials', 'email', 'password',
        'phone', 'address1', 'address2', 'city', 'province', 'postal', 'country',
        'birth_date', 'employment_type', 'job_title', 'vacation_weeks',
        'start_date', 'termination_date', 'pay_type', 'pay_rate_cents',
        'reports_to', 'active', 'role',
    ];

    protected $hidden = ['password', 'remember_token'];

    protected function casts(): array
    {
        return [
            'password' => 'hashed',
            'birth_date' => 'date',
            'start_date' => 'date',
            'termination_date' => 'date',
            'active' => 'boolean',
            'pay_rate_cents' => 'integer',
            'vacation_weeks' => 'decimal:2',
        ];
    }

    public function punches(): HasMany
    {
        return $this->hasMany(Punch::class);
    }

    public function jobs(): BelongsToMany
    {
        return $this->belongsToMany(FenceJob::class)->withTimestamps();
    }

    public function permissions(): HasMany
    {
        return $this->hasMany(EmployeePermission::class);
    }

    public function manager(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'reports_to');
    }

    /** Only hourly staff clock in. Salaried staff have no shift to record. */
    public function clocksIn(): bool
    {
        return $this->active && $this->pay_type === 'hourly';
    }

    public function isOwner(): bool
    {
        return $this->role === 'owner';
    }

    /**
     * Whether a response for this employee may contain cost or margin figures.
     * The one question every serializer has to ask before it writes a number.
     */
    public function seesCost(): bool
    {
        return $this->role === 'owner';
    }

    public function seesScope(): bool
    {
        return in_array($this->role, ['owner', 'crew_lead'], true);
    }

    public function hasPermission(string $key): bool
    {
        return $this->isOwner()
            || $this->permissions->contains('permission', $key);
    }
}
