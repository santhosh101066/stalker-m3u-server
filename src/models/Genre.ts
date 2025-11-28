import {
    Table,
    Column,
    Model,
    DataType,
    PrimaryKey,
    Index,
} from "sequelize-typescript";

export type GenreType = "channel" | "movie" | "series";

@Table({
    tableName: "genres",
    timestamps: true,
})
export class Genre extends Model {
    @PrimaryKey
    @Column(DataType.STRING)
    id!: string;

    @Column(DataType.STRING)
    title!: string;

    @Column(DataType.INTEGER)
    number!: number;

    @Column(DataType.STRING)
    alias!: string;

    @Column(DataType.INTEGER)
    censored!: number;

    @Index
    @Column(DataType.STRING)
    type!: GenreType;

    @Index
    @Column(DataType.INTEGER)
    profileId?: number;
}
